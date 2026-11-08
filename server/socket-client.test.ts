import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlSocket } from "./control-socket";
import type { McpDeps } from "./mcp";
import { defaultSocketPath, parseClientArgs, runClient, socketRequest } from "./socket-client";

const deps = {
  listSessions: async () => [],
  listArchive: () => [],
  hostStats: () => ({}),
  listProjects: () => [],
  listRepos: async () => { await Bun.sleep(20); return ["me/a", "me/b"]; },
  providers: () => [],
  readScreen: async () => ({ ok: true, value: "" }),
  sleep: async () => {},
  now: () => 0,
} as unknown as McpDeps;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cs-cli-"));
  dirs.push(dir);
  return join(dir, "cs.sock");
}

test("sends one request and returns its answer, waiting for a slow tool", async () => {
  const server = startControlSocket({ path: socketPath(), deps, log: () => {} });
  expect(await socketRequest(server.path, "list_repos", { query: "b" })).toMatchObject({ result: { repos: ["me/b"], total: 1 } });
  expect(await socketRequest(server.path, "read_session", { session_id: "m:cs-x" }))
    .toMatchObject({ error: { code: "tool_error", message: expect.stringContaining("No live session") } });
  server.stop();
});

test("params can come from stdin and must be a JSON object", async () => {
  const server = startControlSocket({ path: socketPath(), deps, log: () => {} });
  const env = { CS_SOCKET_PATH: server.path };
  let read = false;
  expect(await runClient(["list_repos", "-"], env, async () => { read = true; return '{"query":"a"}'; })).toBe(0);
  expect(read).toBe(true);
  expect(await runClient(["no_such_method"], env)).toBe(1);
  await expect(runClient(["ping", "[1]"], env)).rejects.toThrow("JSON object");
  await expect(runClient(["ping", "{oops"], env)).rejects.toThrow("JSON object");
  server.stop();
});

test("a request larger than the socket buffer is sent whole", async () => {
  let got = "";
  const server = startControlSocket({ path: socketPath(), deps: { ...deps, sendText: async (_id: string, text: string) => { got = text; return { ok: true, value: true }; } } as McpDeps, log: () => {} });
  const text = "x".repeat(600 * 1024);
  expect(await socketRequest(server.path, "send_message", { session_id: "m:cs-x", text })).toMatchObject({ result: { sent: true } });
  expect(got.length).toBe(text.length);
  server.stop();
});

test("gives up when no answer arrives in time", async () => {
  const server = startControlSocket({ path: socketPath(), deps: { ...deps, listRepos: () => new Promise(() => {}) } as McpDeps, log: () => {} });
  await expect(socketRequest(server.path, "list_repos", {}, 50)).rejects.toThrow("no answer");
  server.stop();
});

test("a missing socket says how to turn it on", async () => {
  await expect(socketRequest(socketPath(), "ping")).rejects.toThrow("CS_SOCKET");
});

test("the socket path comes from --socket, CS_SOCKET_PATH, then CS_DATA_DIR", () => {
  expect(defaultSocketPath({ CS_SOCKET_PATH: "/a/cs.sock", CS_DATA_DIR: "/d" })).toBe("/a/cs.sock");
  expect(defaultSocketPath({ CS_DATA_DIR: "/d" })).toBe("/d/cs.sock");
  expect(defaultSocketPath({})).toBeNull();
  expect(parseClientArgs(["--socket=/s.sock", "list_sessions", '{"include_ended":true}'], {}))
    .toEqual({ path: "/s.sock", method: "list_sessions", params: '{"include_ended":true}' });
  expect(parseClientArgs(["ping"], { CS_SOCKET_PATH: "/e.sock" })).toEqual({ path: "/e.sock", method: "ping", params: undefined });
  expect(() => parseClientArgs([], { CS_SOCKET_PATH: "/e.sock" })).toThrow("method");
  expect(() => parseClientArgs(["ping"], {})).toThrow("--socket");
});
