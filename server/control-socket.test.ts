import { afterEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLineSplitter, handleRequest, parseRequest, prepareSocketPath, socketMethods, startControlSocket } from "./control-socket";
import { TOOLS, type McpDeps } from "./mcp";

function deps(over: Partial<McpDeps> = {}): McpDeps {
  return {
    listSessions: async () => [],
    listArchive: () => [],
    hostStats: () => ({ cpu: 1 }),
    listProjects: () => [{ id: 1, path: "/srv/demo", label: "Demo" }],
    listRepos: async () => ["me/a"],
    providers: () => [{ id: "claude", name: "Claude", remoteControl: true, turnState: true }],
    launch: async ({ name }) => ({ ok: true, id: `m:cs-${name}` }),
    end: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    readScreen: async () => ({ ok: true, value: "ready" }),
    sendText: async () => ({ ok: true, value: true }),
    sendKeys: async () => ({ ok: true, value: true }),
    sleep: async () => {},
    now: () => 0,
    ...over,
  };
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cs-sock-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/* ---------- protocol ---------- */

test("parses one request per line and keeps whatever id the caller chose", () => {
  expect(parseRequest('{"id":"a1","method":"ping"}')).toEqual({ ok: true, request: { id: "a1", method: "ping", params: {} } });
  expect(parseRequest('{"id":7,"method":"list_sessions","params":{"include_ended":true}}'))
    .toEqual({ ok: true, request: { id: 7, method: "list_sessions", params: { include_ended: true } } });
  expect(parseRequest('{"method":"ping"}')).toMatchObject({ ok: true, request: { id: null } });
});

test("malformed lines get error codes, not a dropped connection", () => {
  const code = (line: string): any => { const r = parseRequest(line); return r.ok ? null : r.reply; };
  expect(code("{not json")).toEqual({ id: null, error: { code: "parse_error", message: expect.any(String) } });
  expect(code("[1,2]")?.error.code).toBe("invalid_request");
  expect(code('"ping"')?.error.code).toBe("invalid_request");
  expect(code('{"id":3}')).toMatchObject({ id: 3, error: { code: "invalid_request" } });
  expect(code('{"id":4,"method":"ping","params":[1]}')).toMatchObject({ id: 4, error: { code: "invalid_request" } });
});

test("ping and methods answer without touching a Session", async () => {
  expect(await handleRequest(deps(), { id: 1, method: "ping", params: {} })).toEqual({ id: 1, result: { pong: true } });
  const reply = await handleRequest(deps(), { id: 2, method: "methods", params: {} }) as any;
  const names = reply.result.methods.map((m: any) => m.name);
  expect(names).toEqual(["ping", "methods", ...TOOLS.map((t) => t.name)]);
  expect(reply.result.methods.find((m: any) => m.name === "send_message").params.required).toEqual(["session_id", "text"]);
  expect(socketMethods()).toHaveLength(TOOLS.length + 2);
});

test("every MCP tool name runs that tool's handler with params as its arguments", async () => {
  const listed = await handleRequest(deps(), { id: 1, method: "list_sessions", params: {} });
  expect(listed).toEqual({ id: 1, result: { sessions: [], host: { cpu: 1 } } });
  const repos = await handleRequest(deps({ listRepos: async () => ["me/a", "you/b"] }), { id: 2, method: "list_repos", params: { query: "YOU" } });
  expect(repos).toEqual({ id: 2, result: { repos: ["you/b"], total: 1 } });
  const launched = await handleRequest(deps(), { id: 3, method: "launch_session", params: { name: "x", project_id: 1 } });
  expect(launched).toEqual({ id: 3, result: { session_id: "m:cs-x", launched: true, next: "send_message" } });
});

test("a tool's own refusal comes back as tool_error with the tool's message", async () => {
  const reply = await handleRequest(deps(), { id: 9, method: "read_session", params: { session_id: "m:cs-gone" } });
  expect(reply).toEqual({ id: 9, error: { code: "tool_error", message: "No live session m:cs-gone. list_sessions shows the live ones." } });
  const thrown = await handleRequest(deps({ listSessions: async () => { throw new Error("boom"); } }), { id: 10, method: "list_sessions", params: {} });
  expect(thrown).toEqual({ id: 10, error: { code: "internal", message: "boom" } });
});

test("only the MCP tool set is reachable", async () => {
  for (const method of ["tools/call", "initialize", "__proto__", "toString", "constructor", "send", "list_connectors", "read_messages", ""]) {
    const reply = await handleRequest(deps(), { id: 1, method, params: {} }) as any;
    expect(reply.error?.code).toBe("unknown_method");
  }
});

test("the line splitter handles split and joined chunks and refuses an oversized line", () => {
  const split = createLineSplitter(32);
  const enc = (s: string) => new TextEncoder().encode(s);
  expect(split.push(enc('{"id":1,'))).toEqual([]);
  expect(split.push(enc('"method":"ping"}\n{"id":2}\r\n\n{"i'))).toEqual(['{"id":1,"method":"ping"}', '{"id":2}']);
  expect(split.push(enc('d":3}\n'))).toEqual(['{"id":3}']);
  // A multi-byte character split across chunks still decodes.
  const bytes = enc('"é"\n');
  expect(split.push(bytes.slice(0, 2))).toEqual([]);
  expect(split.push(bytes.slice(2))).toEqual(['"é"']);
  expect(split.push(enc("x".repeat(40)))).toBeNull();
  expect(createLineSplitter(8).push(enc("123456789\n"))).toBeNull();
});

/* ---------- socket file and directory ---------- */

test("refuses a directory others can open and a path that is not a socket", () => {
  const dir = tempDir();
  chmodSync(dir, 0o755);
  expect(() => prepareSocketPath(join(dir, "cs.sock"))).toThrow("0700");
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "cs.sock"), "not a socket");
  expect(() => prepareSocketPath(join(dir, "cs.sock"))).toThrow("not a socket");
  mkdirSync(join(dir, "folder"));
  expect(() => prepareSocketPath(join(dir, "folder"))).toThrow("not a socket");
});

test("creates a missing directory 0700", () => {
  const dir = tempDir();
  prepareSocketPath(join(dir, "run", "cs.sock"));
  expect(statSync(join(dir, "run")).mode & 0o777).toBe(0o700);
});

/* ---------- the real socket ---------- */

async function client(path: string) {
  const lines: string[] = [];
  let wake = () => {};
  let closed = false;
  let buffer = "";
  const socket = await Bun.connect({
    unix: path,
    socket: {
      data(_s, chunk) {
        buffer += new TextDecoder().decode(chunk);
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) { lines.push(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
        wake();
      },
      close() { closed = true; wake(); },
    },
  });
  const next = async (count = 1) => {
    while (lines.length < count && !closed) await new Promise<void>((r) => { wake = r; });
    return lines.splice(0, count).map((l) => JSON.parse(l));
  };
  return { socket, next, isClosed: () => closed };
}

test("the socket file is 0600, answers requests and replaces a leftover socket", async () => {
  const dir = tempDir();
  const path = join(dir, "cs.sock");
  const logs: string[] = [];
  const first = startControlSocket({ path, deps: deps(), log: (line) => logs.push(line) });
  expect(lstatSync(path).isSocket()).toBe(true);
  expect(lstatSync(path).mode & 0o777).toBe(0o600);

  const c = await client(path);
  c.socket.write('{"id":1,"method":"ping"}\n{"id":2,"method":"send_message","params":{"session_id":"m:cs-x","text":"secret-text"}}\n');
  const replies = await c.next(2);
  expect(replies).toContainEqual({ id: 1, result: { pong: true } });
  expect(replies).toContainEqual({ id: 2, result: { session_id: "m:cs-x", sent: true, next: "wait_for_session" } });
  c.socket.write("{oops\n");
  expect((await c.next())[0].error.code).toBe("parse_error");
  c.socket.end();

  // One log line per call: method, outcome and time, never params.
  expect(logs.some((l) => /send_message ok \d+ms/.test(l))).toBe(true);
  expect(logs.join("\n")).not.toContain("secret-text");

  first.stop();
  expect(() => lstatSync(path)).toThrow();

  // A server that was killed leaves its socket file behind; the next start replaces it.
  const crashed = Bun.spawn([process.execPath, "-e",
    `Bun.listen({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); console.log("up"); setInterval(() => {}, 1000);`],
  { stdout: "pipe" });
  const reader = crashed.stdout.getReader();
  await reader.read();
  crashed.kill("SIGKILL");
  await crashed.exited;
  expect(lstatSync(path).isSocket()).toBe(true);
  const second = startControlSocket({ path, deps: deps(), log: () => {} });
  const again = await client(path);
  again.socket.write('{"id":"x","method":"ping"}\n');
  expect(await again.next()).toEqual([{ id: "x", result: { pong: true } }]);
  again.socket.end();
  second.stop();
});

test("too many requests in flight get busy; an oversized line closes only that connection", async () => {
  const path = join(tempDir(), "cs.sock");
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const slow = deps({ listRepos: async () => { await gate; return []; } });
  const server = startControlSocket({ path, deps: slow, log: () => {}, limits: { perConnection: 2, maxLineBytes: 64 } });

  const c = await client(path);
  c.socket.write('{"id":1,"method":"list_repos"}\n{"id":2,"method":"list_repos"}\n{"id":3,"method":"list_repos"}\n');
  expect(await c.next()).toEqual([{ id: 3, error: { code: "busy", message: expect.any(String) } }]);
  release();
  expect((await c.next(2)).map((r) => r.id).sort()).toEqual([1, 2]);

  const other = await client(path);
  const big = await client(path);
  big.socket.write(`{"id":1,"method":"ping","params":{"pad":"${"x".repeat(100)}"}}\n`);
  expect((await big.next())[0].error.code).toBe("too_large");
  await big.next(); // waits for the close
  expect(big.isClosed()).toBe(true);
  other.socket.write('{"id":5,"method":"ping"}\n');
  expect(await other.next()).toEqual([{ id: 5, result: { pong: true } }]);
  c.socket.end();
  other.socket.end();
  server.stop();
});

// What `nc -U` and `socat` do when their input ends. Bun 1.3 closes the whole connection
// when the client closes its end, whatever allowHalfOpen says; 1.4.4 keeps it open.
test.skipIf(!Bun.semver.satisfies(Bun.version, ">=1.4.4"))("a client that sends its requests and closes its end still gets every answer", async () => {
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const server = startControlSocket({ path: join(tempDir(), "cs.sock"), deps: deps({ listRepos: async () => { await gate; return ["me/a"]; } }), log: () => {} });
  const received = await new Promise<string>((resolve, reject) => {
    let text = "";
    const conn = createConnection({ path: server.path, allowHalfOpen: true });
    conn.on("data", (chunk) => { text += chunk.toString(); if (text.includes('"pong"')) setTimeout(release, 50); });
    conn.on("end", () => resolve(text)); // the server closes once both answers are out
    conn.on("error", reject);
    conn.end('{"id":1,"method":"ping"}\n{"id":2,"method":"list_repos"}\n');
  });
  expect(received.trim().split("\n").map((l) => JSON.parse(l))).toEqual([
    { id: 1, result: { pong: true } },
    { id: 2, result: { repos: ["me/a"], total: 1 } },
  ]);
  server.stop();
});

test("connections over the limit are told so and closed", async () => {
  const server = startControlSocket({ path: join(tempDir(), "cs.sock"), deps: deps(), log: () => {}, limits: { connections: 1 } });
  const first = await client(server.path);
  const second = await client(server.path);
  expect((await second.next())[0].error.code).toBe("busy");
  await second.next();
  expect(second.isClosed()).toBe(true);
  first.socket.write('{"id":1,"method":"ping"}\n');
  expect(await first.next()).toEqual([{ id: 1, result: { pong: true } }]);
  first.socket.end();
  server.stop();
});
