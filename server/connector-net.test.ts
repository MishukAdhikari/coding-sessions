import { afterEach, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DestinationError, preSend, readBounded, safeFetch, validateServerUrl } from "./connector-net";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const LOOPBACK = { allowLoopback: true };
const within = <T>(promise: Promise<T>, ms = 5000) => Promise.race([promise, Bun.sleep(ms).then(() => { throw new Error("test timed out"); })]);

/** A raw TCP server, so tests can send what a real HTTP server library would refuse to. */
async function raw(onConnection: (socket: Socket) => void): Promise<{ url: string; sockets: Socket[]; requests: number }> {
  const state = { url: "", sockets: [] as Socket[], requests: 0 };
  const server: Server = createServer(socket => { state.sockets.push(socket); socket.once("data", () => state.requests++); socket.on("error", () => {}); onConnection(socket); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => { for (const socket of state.sockets) socket.destroy(); server.close(); });
  state.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  return state;
}

test("a status outside 200–599 is rejected without crashing the process", async () => {
  const server = await raw(socket => socket.once("data", () => socket.write("HTTP/1.1 600 Odd\r\ncontent-length: 2\r\n\r\nhi")));
  await expect(within(safeFetch({ policy: LOOPBACK, env: {} })(server.url, { method: "POST", body: "{}" }))).rejects.toThrow(/invalid response/);
  expect(process.exitCode ?? 0).toBe(0);
});

test("an endless redirect body is not drained, and the connection is closed", async () => {
  let closed = false;
  const server = await raw(socket => {
    socket.on("close", () => { closed = true; });
    socket.once("data", () => {
      socket.write("HTTP/1.1 302 Found\r\nlocation: http://169.254.169.254/\r\ntransfer-encoding: chunked\r\n\r\n");
      const timer = setInterval(() => { if (!socket.destroyed) socket.write("400\r\n" + "x".repeat(1024) + "\r\n"); }, 5);
      socket.on("close", () => clearInterval(timer));
    });
  });
  await expect(within(safeFetch({ policy: LOOPBACK, env: {} })(server.url, { method: "POST", body: "{}" }))).rejects.toThrow(/redirect/);
  for (let i = 0; i < 50 && !closed; i++) await Bun.sleep(20);
  expect(closed).toBe(true);
});

test("abort rejects promptly and closes the connection, before or during the body", async () => {
  let closed = 0;
  const server = await raw(socket => {
    socket.on("close", () => closed++);
    socket.once("data", () => { socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n"); });
  });
  const early = new AbortController();
  setTimeout(() => early.abort(new Error("cancelled early")), 50);
  const hung = await raw(() => {});
  await expect(within(safeFetch({ policy: LOOPBACK, env: {} })(hung.url, { method: "POST", body: "{}", signal: early.signal }))).rejects.toThrow(/cancelled early/);
  const late = new AbortController();
  const response = await within(safeFetch({ policy: LOOPBACK, env: {} })(server.url, { method: "POST", body: "{}", signal: late.signal }));
  const reader = response.body!.getReader();
  const read = reader.read();
  late.abort(new Error("cancelled late"));
  await within(read.catch(() => null));
  for (let i = 0; i < 50 && !closed; i++) await Bun.sleep(20);
  expect(closed).toBeGreaterThan(0);
});

test("a token request whose connection closes after it was sent is uncertain, never 'not sent'", async () => {
  const { requestTokens } = await import("./connector-oauth-tokens");
  let received = false;
  const server = await raw(socket => socket.on("data", () => { received = true; socket.destroy(); }));
  const outcome = await within(requestTokens(safeFetch({ policy: LOOPBACK, env: {}, role: "oauth" }), server.url, { clientId: "c", clientSecret: null, tokenAuthMethod: "none" }, { grant_type: "refresh_token", refresh_token: "r".repeat(16) }));
  expect(received).toBe(true);
  expect(outcome.kind).toBe("uncertain");
});

test("ambient proxy variables refuse the request even with NO_PROXY set", async () => {
  const server = await raw(socket => socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n")));
  for (const env of [{ HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: "*" }, { http_proxy: "http://127.0.0.1:1", no_proxy: "127.0.0.1" }, { ALL_PROXY: "socks5://127.0.0.1:1" }]) {
    await expect(within(safeFetch({ policy: LOOPBACK, env })(server.url, { method: "POST", body: "{}" })), JSON.stringify(env)).rejects.toThrow(/proxy would choose/);
  }
  expect(server.requests).toBe(0);
});

test("DNS answers are vetted on every connection: any blocked answer refuses before connecting", async () => {
  const attempts: string[] = [];
  for (const answers of [[{ address: "169.254.169.254", family: 4 }], [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }],
    [{ address: "::ffff:127.0.0.1", family: 6 }], [{ address: "fd00::1", family: 6 }], []]) {
    const resolver = async (host: string) => { attempts.push(host); return answers; };
    await expect(within(safeFetch({ policy: { allowLoopback: false }, resolver, env: {} })("https://rebind.example/mcp", { method: "POST", body: "{}" })))
      .rejects.toThrow(/private, local or reserved/);
  }
  expect(attempts.length).toBe(5);
  await expect(safeFetch({ policy: { allowLoopback: false }, env: {} })("https://10.0.0.1/mcp", { method: "POST" })).rejects.toBeInstanceOf(DestinationError);
});

// Needs the openssl CLI to mint a throwaway certificate; reported as skipped (not passed) without it.
test.skipIf(!Bun.which("openssl"))("TLS verification stays on under NODE_TLS_REJECT_UNAUTHORIZED=0: wrong name and untrusted CA fail before any request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-tls-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const gen = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=other.test",
    "-addext", "subjectAltName=DNS:other.test", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stderr: "ignore", stdout: "ignore" });
  expect(gen.exitCode).toBe(0);
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: Bun.file(join(dir, "cert.pem")), key: Bun.file(join(dir, "key.pem")) }, fetch() { requests++; return new Response("{}"); } });
  cleanup.push(() => server.stop(true));
  const script = `
    import { safeFetch } from ${JSON.stringify(new URL("./connector-net.ts", import.meta.url).pathname)};
    import { readFileSync } from "node:fs";
    const ca = readFileSync(${JSON.stringify(join(dir, "cert.pem"))});
    const out = [];
    // Untrusted CA (no ca given), and trusted CA but the wrong name (cert is for other.test).
    for (const [label, opts] of [["untrusted", {}], ["wrong-name", { ca }]]) {
      try { await safeFetch({ policy: { allowLoopback: true }, env: {}, ...opts })("https://127.0.0.1:${server.port}/mcp", { method: "POST", body: "{}" }); out.push(label + ":accepted"); }
      catch { out.push(label + ":rejected"); }
    }
    console.log(out.join(","));`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { PATH: Bun.env.PATH, NODE_TLS_REJECT_UNAUTHORIZED: "0" }, stdout: "pipe", stderr: "pipe" });
  const output = await within(new Response(child.stdout).text(), 15000);
  await child.exited;
  expect(output.trim()).toBe("untrusted:rejected,wrong-name:rejected");
  expect(requests).toBe(0);
}, 20000);

test("OAuth endpoints may carry a query; MCP server URLs still may not; both refuse userinfo, fragments and private hosts", () => {
  const policy = { allowLoopback: false };
  expect(validateServerUrl("https://as.example/authorize?tenant=x", policy, "oauth").search).toBe("?tenant=x");
  expect(() => validateServerUrl("https://mcp.example/mcp?token=x", policy)).toThrow(DestinationError);
  for (const url of ["https://user:pw@as.example/token", "https://as.example/token#frag", "http://as.example/token", "https://10.0.0.1/token", "https://[fe80::1]/token", "https://localhost/token"]) {
    expect(() => validateServerUrl(url, policy, "oauth"), url).toThrow(DestinationError);
  }
});

test("OAuth transport: GET without a body, form POST, a descriptive User-Agent, and query preserved", async () => {
  const seen: Array<{ method: string; url: string; ua: string | null; type: string | null; length: string | null; body: string }> = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    seen.push({ method: req.method, url: new URL(req.url).pathname + new URL(req.url).search, ua: req.headers.get("user-agent"), type: req.headers.get("content-type"), length: req.headers.get("content-length"), body: await req.text() });
    return Response.json({ ok: true });
  } });
  cleanup.push(() => server.stop(true));
  const fetcher = safeFetch({ policy: LOOPBACK, env: {}, role: "oauth" });
  const base = `http://127.0.0.1:${server.port}`;
  expect((await within(fetcher(`${base}/.well-known/oauth-authorization-server?x=1`, { method: "GET" }))).status).toBe(200);
  await within(fetcher(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: "c" }).toString() }));
  expect(seen[0]).toMatchObject({ method: "GET", url: "/.well-known/oauth-authorization-server?x=1", body: "" });
  expect(seen[0]!.length === null || seen[0]!.length === "0").toBe(true);
  expect(seen[0]!.ua).toMatch(/^Coding-Sessions\//);
  expect(seen[1]).toMatchObject({ method: "POST", type: "application/x-www-form-urlencoded", body: "grant_type=authorization_code&code=c" });
  // The MCP role keeps refusing query strings.
  await expect(safeFetch({ policy: LOOPBACK, env: {} })(`${base}/mcp?x=1`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(DestinationError);
});

test("readBounded refuses oversized bodies and stops reading", async () => {
  const big = new Response("x".repeat(70_000));
  await expect(readBounded(big, 64 * 1024)).rejects.toThrow(/too large/);
  expect(await readBounded(new Response("small"), 64 * 1024)).toBe("small");
});

test("token requests that provably never left are 'not sent'; a drop after sending stays uncertain", async () => {
  const { requestTokens } = await import("./connector-oauth-tokens");
  const client = { clientId: "c", clientSecret: null, tokenAuthMethod: "none" as const };
  const fields = { grant_type: "refresh_token", refresh_token: "r".repeat(16) };
  // Name resolution failed: nothing could have been sent.
  const dns = await within(requestTokens(safeFetch({ policy: { allowLoopback: false }, env: {}, role: "oauth",
    resolver: async () => { const e = new Error("getaddrinfo EAI_AGAIN") as NodeJS.ErrnoException; e.code = "EAI_AGAIN"; throw e; } }), "https://as.example/token", client, fields));
  expect(dns.kind).toBe("not_sent");
  // Connection refused.
  const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = closed.port; closed.stop(true);
  expect((await within(requestTokens(safeFetch({ policy: LOOPBACK, env: {}, role: "oauth" }), `http://127.0.0.1:${port}/token`, client, fields))).kind).toBe("not_sent");
  // Dropped after the server received the request: may have rotated, so uncertain.
  let received = false;
  const drop = await raw(socket => socket.on("data", () => { received = true; socket.destroy(); }));
  expect((await within(requestTokens(safeFetch({ policy: LOOPBACK, env: {}, role: "oauth" }), drop.url, client, fields))).kind).toBe("uncertain");
  expect(received).toBe(true);
});

test.skipIf(!Bun.which("openssl"))("a TLS verification failure is 'not sent': the handshake fails before any request reaches the server", async () => {
  const { requestTokens } = await import("./connector-oauth-tokens");
  const dir = mkdtempSync(join(tmpdir(), "cs-tls-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const gen = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=other.test",
    "-addext", "subjectAltName=DNS:other.test", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stderr: "ignore", stdout: "ignore" });
  expect(gen.exitCode).toBe(0);
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert: Bun.file(join(dir, "cert.pem")), key: Bun.file(join(dir, "key.pem")) }, fetch() { requests++; return new Response("{}"); } });
  cleanup.push(() => server.stop(true));
  const outcome = await within(requestTokens(safeFetch({ policy: LOOPBACK, env: {}, role: "oauth" }), `https://127.0.0.1:${server.port}/token`,
    { clientId: "c", clientSecret: null, tokenAuthMethod: "none" }, { grant_type: "refresh_token", refresh_token: "r".repeat(16) }));
  expect(outcome.kind).toBe("not_sent");
  expect(requests).toBe(0);
}, 20000);

test("only proven codes are tagged pre-send; unproven network errors stay uncertain", () => {
  const coded = (code: string) => Object.assign(new Error(code), { code });
  for (const code of ["ECONNREFUSED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"]) expect(preSend(coded(code))?.code).toBe(code);
  for (const code of ["EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "ECONNRESET", "ETIMEDOUT", "EPIPE", "UNKNOWN"]) expect(preSend(coded(code))).toBeNull();
});
