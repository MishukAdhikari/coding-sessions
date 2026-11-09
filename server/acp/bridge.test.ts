import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { sendBridgeCommand } from "./client";
import { readEventWindow, readState, type AcpState } from "./event-log";
import { acpPaths, type AcpPaths } from "./paths";

const BRIDGE = new URL("./bridge.ts", import.meta.url).pathname;
const FAKE = new URL("./fake-agent.ts", import.meta.url).pathname;
const SECRET = "tok-SUPER-SECRET-123";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) { try { fn(); } catch {} } });

interface Harness { paths: AcpPaths; report: string; proc: ReturnType<typeof Bun.spawn> }

function start(env: Record<string, string> = {}, extraArgs: string[] = []): Harness {
  // /tmp keeps the socket path short on macOS
  const base = mkdtempSync("/tmp/csb-");
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const resolved = acpPaths(base, "cs-demo");
  if (!resolved.ok) throw new Error(resolved.error);
  const paths = resolved.paths;
  mkdirSync(paths.dir, { recursive: true });
  chmodSync(paths.root, 0o700);
  chmodSync(paths.dir, 0o700);
  const report = join(base, "report.jsonl");
  const mcp = [{ type: "stdio", command: "/bin/echo", args: ["communicator"], env: { CS_COMMUNICATOR_TOKEN: "${CS_COMMUNICATOR_TOKEN}", CS_COMMUNICATOR_URL: "${CS_COMMUNICATOR_URL}" } }];
  const proc = Bun.spawn([process.execPath, BRIDGE], {
    cwd: base,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CS_ACP_DIR: paths.dir,
      CS_ACP_ARGV: JSON.stringify([process.execPath, FAKE, ...extraArgs]),
      CS_ACP_CWD: base,
      CS_ACP_MCP: JSON.stringify(mcp),
      CS_COMMUNICATOR_TOKEN: SECRET,
      CS_COMMUNICATOR_URL: "http://127.0.0.1:1/mcp/communicator",
      FAKE_REPORT: report,
      ...env,
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  cleanup.push(() => proc.kill("SIGKILL"));
  return { paths, report, proc };
}

async function until(paths: AcpPaths, pred: (s: AcpState) => boolean, ms = 5000): Promise<AcpState> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = readState(paths.state);
    if (s && pred(s)) return s;
    await Bun.sleep(20);
  }
  throw new Error(`state never matched; last: ${JSON.stringify(readState(paths.state))}`);
}

const events = (paths: AcpPaths) => readEventWindow(paths.events, null).events;
const reports = (h: Harness) => existsSync(h.report) ? readFileSync(h.report, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

describe("ACP bridge against the fake agent", () => {
  test("a prompt streams updates into the log and the state follows the turn", async () => {
    const h = start();
    const idle = await until(h.paths, (s) => s.state === "idle");
    expect(idle.acpSessionId).toBe("fake-session-1");
    expect(idle.agent?.name).toBe("fake-agent");
    expect(events(h.paths)[0]?.kind).toBe("status");

    expect(await sendBridgeCommand(h.paths.socket, { op: "prompt", text: "hi" })).toMatchObject({ ok: true });
    await until(h.paths, (s) => s.state === "idle" && events(h.paths).some((e) => e.kind === "turn_end"));
    const kinds = events(h.paths).map((e) => e.kind);
    expect(kinds).toContain("user");
    const chunks = events(h.paths).filter((e) => e.kind === "update" && (e.update as any).sessionUpdate === "agent_message_chunk");
    expect(chunks.map((e) => (e.update as any).content.text).join("")).toBe("Hello world");
    expect(events(h.paths).find((e) => e.kind === "turn_end")).toMatchObject({ stopReason: "end_turn" });
  });

  test("the agent's slash commands land in the state, without the ones the chat could not insert", async () => {
    const h = start({ FAKE_COMMANDS: "1" });
    const s = await until(h.paths, (st) => st.commands.length > 0);
    expect(s.commands).toEqual([
      { name: "review", description: "Review the current changes", hint: "what to focus on" },
      { name: "release", description: "Cut a release", hint: null },
    ]);
    // A command is ordinary prompt text to the agent.
    expect(await sendBridgeCommand(h.paths.socket, { op: "prompt", text: "/review src" })).toMatchObject({ ok: true });
    await until(h.paths, () => events(h.paths).some((e) => e.kind === "user" && e.text === "/review src"));
  });

  test("socket is 0600 inside a 0700 directory", async () => {
    const h = start();
    await until(h.paths, (s) => s.state === "idle");
    expect(statSync(h.paths.socket).mode & 0o777).toBe(0o600);
    expect(statSync(h.paths.dir).mode & 0o777).toBe(0o700);
    expect(statSync(h.paths.events).mode & 0o777).toBe(0o600);
  });

  test("permission round trip: waiting, then the chosen option reaches the agent", async () => {
    const h = start();
    await until(h.paths, (s) => s.state === "idle");
    await sendBridgeCommand(h.paths.socket, { op: "prompt", text: "permission" });
    const waiting = await until(h.paths, (s) => s.state === "waiting");
    expect(waiting.pendingPermissions).toBe(1);
    const request = events(h.paths).find((e) => e.kind === "permission")!;
    expect((request.options as any[]).map((o) => o.name)).toEqual(["Allow once", "Allow always", "Reject"]);

    const refused = await sendBridgeCommand(h.paths.socket, { op: "permission", requestId: String(request.requestId), optionId: "nope" });
    expect(refused.ok).toBe(false);
    expect(readState(h.paths.state)?.state).toBe("waiting");

    expect(await sendBridgeCommand(h.paths.socket, { op: "permission", requestId: String(request.requestId), optionId: "allow-always" })).toMatchObject({ ok: true });
    await until(h.paths, (s) => s.state === "idle" && events(h.paths).some((e) => e.kind === "turn_end"));
    expect(reports(h).find((r) => r.permissionAnswer)?.permissionAnswer).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
    expect(events(h.paths).find((e) => e.kind === "permission_resolved")).toMatchObject({ requestId: request.requestId, optionId: "allow-always", auto: false });
  });

  test("cancel answers a pending permission as cancelled and ends the turn cancelled", async () => {
    const h = start();
    await until(h.paths, (s) => s.state === "idle");
    await sendBridgeCommand(h.paths.socket, { op: "prompt", text: "permission" });
    await until(h.paths, (s) => s.state === "waiting");
    expect(await sendBridgeCommand(h.paths.socket, { op: "cancel" })).toMatchObject({ ok: true });
    await until(h.paths, (s) => s.state === "idle" && events(h.paths).some((e) => e.kind === "turn_end"));
    expect(reports(h).find((r) => r.permissionAnswer)?.permissionAnswer).toEqual({ outcome: { outcome: "cancelled" } });
    expect(events(h.paths).find((e) => e.kind === "turn_end")).toMatchObject({ stopReason: "cancelled" });
  });

  test("a prompt while a turn runs is refused", async () => {
    const h = start();
    await until(h.paths, (s) => s.state === "idle");
    await sendBridgeCommand(h.paths.socket, { op: "prompt", text: "slow" });
    await until(h.paths, (s) => s.state === "working");
    const second = await sendBridgeCommand(h.paths.socket, { op: "prompt", text: "again" });
    expect(second.ok).toBe(false);
    expect(await sendBridgeCommand(h.paths.socket, { op: "cancel" })).toMatchObject({ ok: true });
    await until(h.paths, (s) => s.state === "idle");
  });

  test("unrestricted mode auto-answers allow_once, but never picks allow_always", async () => {
    const h = start({ CS_ACP_AUTO_ALLOW: "1" });
    await until(h.paths, (s) => s.state === "idle");
    await sendBridgeCommand(h.paths.socket, { op: "prompt", text: "permission" });
    await until(h.paths, (s) => s.state === "idle" && events(h.paths).some((e) => e.kind === "turn_end"));
    expect(events(h.paths).find((e) => e.kind === "permission_resolved")).toMatchObject({ optionId: "allow-once", auto: true });

    await sendBridgeCommand(h.paths.socket, { op: "prompt", text: "always-only" });
    const waiting = await until(h.paths, (s) => s.state === "waiting");
    expect(waiting.pendingPermissions).toBe(1);
    await sendBridgeCommand(h.paths.socket, { op: "cancel" });
  });

  test("resume uses session/load when the agent supports it and logs the replay", async () => {
    const h = start({ FAKE_LOAD_SESSION: "1", CS_ACP_RESUME: "old-session-9" });
    const idle = await until(h.paths, (s) => s.state === "idle");
    expect(idle.acpSessionId).toBe("old-session-9");
    expect(reports(h).find((r) => r.method)?.method).toBe("session/load");
    const replay = events(h.paths).filter((e) => e.kind === "update").map((e) => (e.update as any).content.text);
    expect(replay).toEqual(["earlier question", "earlier answer"]);
  });

  test("resume without loadSession starts a new session and says so", async () => {
    const h = start({ CS_ACP_RESUME: "old-session-9" });
    const idle = await until(h.paths, (s) => s.state === "idle");
    expect(idle.acpSessionId).toBe("fake-session-1");
    expect(reports(h).find((r) => r.method)?.method).toBe("session/new");
    const notice = events(h.paths).find((e) => e.kind === "notice");
    expect(String(notice?.text)).toContain("new conversation");
  });

  test("secrets: not in the agent's argv, expanded into mcpServers env, absent from the log", async () => {
    const h = start();
    await until(h.paths, (s) => s.state === "idle");
    await sendBridgeCommand(h.paths.socket, { op: "prompt", text: "hi" });
    await until(h.paths, (s) => s.state === "idle" && events(h.paths).some((e) => e.kind === "turn_end"));
    const r = reports(h);
    expect(JSON.stringify(r[0].argv)).not.toContain(SECRET);
    expect(r[0].envToken).toBe(SECRET); // inherited through the environment
    expect(r[0].acpEnvLeft).toEqual([]); // bridge config is not passed on
    const servers = r.find((x) => x.method)?.mcpServers;
    expect(servers[0]).toMatchObject({ name: "coding-sessions", command: "/bin/echo", args: ["communicator"] });
    expect(servers[0].env).toContainEqual({ name: "CS_COMMUNICATOR_TOKEN", value: SECRET });
    expect(servers[0].type).toBeUndefined();
    expect(readFileSync(h.paths.events, "utf8")).not.toContain(SECRET);
    expect(readFileSync(h.paths.state, "utf8")).not.toContain(SECRET);
  });

  test("a failed session/new leaves the bridge up in the failed state with the agent's error", async () => {
    const h = start({ FAKE_FAIL_NEW: "1" });
    const failed = await until(h.paths, (s) => s.state === "failed");
    expect(failed.error).toContain("Authentication required");
    expect(events(h.paths).some((e) => e.kind === "notice")).toBe(true);
    expect(h.proc.exitCode).toBeNull();
  });

  test("the agent exiting ends the bridge and the state reads exited", async () => {
    const h = start();
    await until(h.paths, (s) => s.state === "idle");
    await sendBridgeCommand(h.paths.socket, { op: "prompt", text: "exit" });
    const code = await h.proc.exited;
    expect(code).toBe(3);
    expect(readState(h.paths.state)?.state).toBe("exited");
    expect(existsSync(h.paths.socket)).toBe(false);
  });
});
