import { afterEach, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DestinationError, safeFetch } from "./connector-net";

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
