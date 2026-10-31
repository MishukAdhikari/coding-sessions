import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { applyDatabaseSchema } from "./db-schema";
import { createSecretCodec } from "./secrets";
import { Connectors } from "./connectors";
import { Communicator } from "./communicator";
import { handleConnectorRequest } from "./connector-mcp";
import { communicatorEnvironment, installCommandCodeCommunicator, providerCommunicatorArgs } from "./communicator-config";
import { startCommunicatingSession } from "./sessions";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const script = new URL("./connector-stdio.ts", import.meta.url).pathname;
const TOOLS = [
  { name: "lab_list", description: "List labs", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "env_status", description: "Status", inputSchema: { type: "object", properties: { environment: { type: "string" } }, additionalProperties: false } },
];

function upstream() {
  const server = Bun.serve({ port: 0, async fetch(req) {
    const msg = await req.json() as any;
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const result = msg.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, instructions: "" }
      : msg.method === "tools/list" ? { tools: TOOLS } : { content: [{ type: "text", text: `called ${msg.params.name}` }] };
    return Response.json({ jsonrpc: "2.0", id: msg.id, result });
  } });
  cleanup.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}/mcp`;
}

async function gateway() {
  const database = new Database(":memory:"); applyDatabaseSchema(database);
  const key = randomBytes(32);
  const connectors = new Connectors({ database, isLive: async () => true, codec: () => createSecretCodec(key), env: { CS_CONNECTOR_ALLOW_LOOPBACK: "1" } });
  const { id } = await connectors.add({ name: "Lab", url: upstream(), token: "upstream-credential-0001" });
  await connectors.check(id);
  connectors.setTools(id, ["lab_list"]);
  connectors.setDefaultProviders(id, ["claude"]);
  const launchId = randomUUID();
  database.query("INSERT INTO launches (screen,name,project_path,created_at,provider,launch_id,phase) VALUES ('cs-a','a','/srv',1,'claude',?,'ready')").run(launchId);
  const token = connectors.prepare(launchId)!;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => handleConnectorRequest(connectors, req) });
  cleanup.push(() => server.stop(true));
  return { connectors, id, launchId, token, url: `http://127.0.0.1:${server.port}/mcp/connectors` };
}

function bridge(url: string, token: string) {
  const child = Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { PATH: Bun.env.PATH, CS_CONNECTOR_URL: url, CS_CONNECTOR_TOKEN: token, CS_CONNECTOR_REVISION_MS: "100" } });
  const rows: any[] = [];
  const waiters: Array<() => void> = [];
  void (async () => {
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += Buffer.from(chunk).toString();
      for (let end; (end = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(end + 1)) { rows.push(JSON.parse(buffer.slice(0, end))); waiters.splice(0).forEach(fn => fn()); }
    }
  })();
  const until = async (match: (row: any) => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = rows.find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("timed out waiting for bridge output");
      await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, 50); });
    }
  };
  let seq = 0;
  const request = (method: string, params = {}) => { const id = ++seq; child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return until(row => row.id === id); };
  cleanup.push(() => child.kill());
  return { child, rows, until, request };
}

test("stdio bridge lists and calls granted tools and announces grant changes made before its first poll", async () => {
  const g = await gateway();
  const b = bridge(g.url, g.token);
  const init = await b.request("initialize", { protocolVersion: "2025-11-25" });
  expect(init.result.capabilities.tools.listChanged).toBe(true);
  const listed = await b.request("tools/list");
  expect(listed.result.tools.map((tool: any) => tool.name).sort()).toEqual(["lab__lab_list", "list_connections"]);
  g.connectors.setTools(g.id, ["lab_list", "env_status"]); // before the first poll
  await b.until(row => row.method === "notifications/tools/list_changed");
  expect((await b.request("tools/list")).result.tools.map((tool: any) => tool.name)).toContain("lab__env_status");
  expect((await b.request("tools/call", { name: "lab__lab_list", arguments: {} })).result.content[0].text).toBe("called lab_list");
  expect((await b.request("coding_sessions/tools_revision")).error.code).toBe(-32601);
  const started = Date.now();
  b.child.stdin.end();
  await b.child.exited;
  expect(Date.now() - started).toBeLessThan(2000);
  expect(JSON.stringify(b.rows)).not.toContain("upstream-credential");
});

test("a revoked bridge stops polling and its calls fail without exposing credentials", async () => {
  const g = await gateway();
  const b = bridge(g.url, g.token);
  await b.request("initialize", {});
  g.connectors.revoke(g.launchId);
  const failed = await b.request("tools/call", { name: "lab__lab_list", arguments: {} });
  expect(failed.error.message).toMatch(/lost access|ended/);
  await Bun.sleep(300);
  expect(b.child.exitCode).toBeNull();
  b.child.stdin.end();
  await b.child.exited;
});

test("the bridge refuses to start without a managed launch's capability", async () => {
  const child = Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: Bun.env.PATH, CS_CONNECTOR_URL: "http://127.0.0.1:1/mcp/connectors", CS_CONNECTOR_TOKEN: "cscomm_" + "a".repeat(43) } });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain("unavailable outside a configured managed launch");
});

test("launch adapters add the connector entry only when connectors are available, without credential literals", async () => {
  const paths = { bunPath: "/opt/bun", bridgePath: "/opt/app/communicator-stdio.ts", connectorBridgePath: "/opt/app/connector-stdio.ts" };
  const plain = await providerCommunicatorArgs("claude", "/srv", paths);
  expect(Object.keys(JSON.parse(plain[1]!).mcpServers)).toEqual(["coding_sessions_communicator"]);
  const claude = JSON.parse((await providerCommunicatorArgs("claude", "/srv", { ...paths, connectors: true }))[1]!).mcpServers;
  expect(claude.coding_sessions_connectors).toEqual({ type: "stdio", command: "/opt/bun", args: ["/opt/app/connector-stdio.ts"], env: { CS_CONNECTOR_TOKEN: "${CS_CONNECTOR_TOKEN}", CS_CONNECTOR_URL: "${CS_CONNECTOR_URL}" } });
  const codex = await providerCommunicatorArgs("codex", "/srv", { ...paths, connectors: true });
  expect(codex.length).toBe(4);
  const parsed = Bun.TOML.parse(codex[3]!) as any;
  expect(parsed.mcp_servers.coding_sessions_connectors).toMatchObject({ env_vars: ["CS_CONNECTOR_TOKEN", "CS_CONNECTOR_URL"], tool_timeout_sec: 130 });
  expect(communicatorEnvironment("c", 9121, "k")).toMatchObject({ CS_CONNECTOR_TOKEN: "k", CS_CONNECTOR_URL: "http://127.0.0.1:9121/mcp/connectors" });
  expect(communicatorEnvironment("c", 9121)).not.toHaveProperty("CS_CONNECTOR_TOKEN");

  const home = mkdtempSync(join(tmpdir(), "cs-conn-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, ".commandcode/projects/demo/mcp.json");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ mcpServers: { mine: { command: "x" } } }));
  installCommandCodeCommunicator(home, "demo", paths, true);
  const added = JSON.parse(readFileSync(file, "utf8"));
  expect(Object.keys(added.mcpServers).sort()).toEqual(["coding_sessions_communicator", "coding_sessions_connectors", "mine"]);
  installCommandCodeCommunicator(home, "demo", paths, false);
  const removed = JSON.parse(readFileSync(file, "utf8"));
  expect(Object.keys(removed.mcpServers).sort()).toEqual(["coding_sessions_communicator", "mine"]);
  expect(removed._codingSessionsConnectors).toBeUndefined();
  // An operator's own entry under that name is never touched, and never blocks a launch without connectors.
  writeFileSync(file, JSON.stringify({ mcpServers: { coding_sessions_connectors: { command: "theirs" } } }));
  installCommandCodeCommunicator(home, "demo", paths, false);
  expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.coding_sessions_connectors).toEqual({ command: "theirs" });
  expect(() => installCommandCodeCommunicator(home, "demo", paths, true)).toThrow(/already used/);
});

test("managed launches receive a separate connector capability through env only, revoked on spawn failure", async () => {
  const database = new Database(":memory:"); applyDatabaseSchema(database);
  const key = randomBytes(32);
  const connectors = new Connectors({ database, isLive: async () => true, codec: () => createSecretCodec(key), env: { CS_CONNECTOR_ALLOW_LOOPBACK: "1" } });
  const communicator = new Communicator(database, { isLive: async () => true });
  let seen: Record<string, string> = {};
  let configured: boolean | undefined;
  const runtime = (code: number) => ({ database, communicator, connectors, hasHolder: async () => false, uuid: randomUUID, now: () => 1,
    configure: async (_p: string, _c: string, _b?: string, withConnectors?: boolean) => { configured = withConnectors; return []; },
    spawn: async (_s: string, cmd: string, { env }: { env?: Record<string, string> } = {}) => { seen = env!; expect(cmd).not.toContain(env!.CS_CONNECTOR_TOKEN ?? "none"); return { code, out: "", err: "" }; } });
  const options = (name: string) => ({ screen: `cs-${name}`, name, projectPath: "/srv", provider: "claude" as const, remoteControl: 0, command: () => "agent" });
  expect(await startCommunicatingSession(options("none"), runtime(0) as any)).toEqual({ ok: true });
  expect(configured).toBe(false);
  expect(seen.CS_CONNECTOR_TOKEN).toBeUndefined();
  await connectors.add({ name: "Local", url: "http://127.0.0.1:1/mcp" });
  expect(await startCommunicatingSession(options("with"), runtime(0) as any)).toEqual({ ok: true });
  expect(configured).toBe(true);
  expect(seen.CS_CONNECTOR_TOKEN).toMatch(/^csconn_/);
  expect(seen.CS_CONNECTOR_TOKEN).not.toBe(seen.CS_COMMUNICATOR_TOKEN);
  expect((await connectors.identity(seen.CS_CONNECTOR_TOKEN!)).name).toBe("with");
  expect(await startCommunicatingSession(options("fails"), runtime(1) as any)).toMatchObject({ ok: false });
  await expect(connectors.identity(seen.CS_CONNECTOR_TOKEN!)).rejects.toThrow();
});
