/** The server side of Chat (ACP) mode: agents, launch, state mapping, routes and MCP I/O. */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { applyDatabaseSchema } from "../db-schema";
import { countActivity } from "../activity-signal";
import { sessionState } from "../mcp";
import { sessionActivity } from "../session-activity";
import { archiveManagedLaunch, type LaunchRow, type SessionInfo } from "../sessions";
import { launchOptionsFromRequest } from "../session-provider";
import { PRESET_ACP_ARGS, acpCommand, type AcpResolveDeps } from "./agents";
import type { BridgeCommand } from "./client";
import { createEventWriter, writeState, type AcpState } from "./event-log";
import { acpAwareIo, pendingPermissions } from "./io";
import { buildAcpLaunch } from "./launch";
import { acpPaths } from "./paths";
import { handleAcpRoute, parseAcpCommand } from "./route";
import { acpSessionFields } from "./state-map";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) { try { fn(); } catch {} } });
const base = () => { const d = mkdtempSync("/tmp/csa-"); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };

function db() {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  return database;
}

function acpRow(database: Database, screen = "cs-chat", provider = "claude") {
  database.query("INSERT INTO launches (screen, name, project_path, created_at, provider, launch_id, phase, mode) VALUES (?, ?, '/srv/p', 1, ?, 'L1', 'ready', 'acp')")
    .run(screen, screen.slice(3), provider);
}

/** A session dir with a log and state, as the bridge leaves them. */
function bridgeFiles(dataDir: string, screen: string, state: Partial<AcpState> & { state: AcpState["state"] }, events: Array<[string, Record<string, unknown>]> = []) {
  const r = acpPaths(dataDir, screen);
  if (!r.ok) throw new Error(r.error);
  mkdirSync(r.paths.dir, { recursive: true });
  chmodSync(r.paths.root, 0o700);
  chmodSync(r.paths.dir, 0o700);
  const w = createEventWriter(r.paths.events);
  for (const [kind, fields] of events) w.append(kind as any, fields);
  w.close();
  writeState(r.paths.state, { acpSessionId: "s1", loadSession: true, agent: { name: "fake", title: "Fake", version: "1" }, pendingPermissions: 0, error: null, ...state });
  return r.paths;
}

describe("agents", () => {
  const deps = (installed: string[]): AcpResolveDeps => ({
    bin: (name) => (installed.includes(name) ? `/opt/bin/${name}` : null),
    commandCode: async () => ({ ok: true, bin: "/opt/bin/command-code" }),
  });

  test("built-ins map to their verified ACP commands", async () => {
    expect(await acpCommand("claude", deps(["claude-agent-acp"]))).toEqual({ ok: true, argv: ["/opt/bin/claude-agent-acp"] });
    expect(await acpCommand("codex", deps(["codex-acp"]))).toEqual({ ok: true, argv: ["/opt/bin/codex-acp"] });
    expect(await acpCommand("command-code", deps([]))).toEqual({ ok: true, argv: ["/opt/bin/command-code", "acp"] });
  });

  test("presets use their own ACP flag or subcommand", () => {
    expect(PRESET_ACP_ARGS).toEqual({ gemini: ["--acp"], qwen: ["--acp"], opencode: ["acp"], kimi: ["acp"] });
  });

  test("a missing adapter names the npm package that installs it", async () => {
    const r = await acpCommand("claude", deps([]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("npm install -g @agentclientprotocol/claude-agent-acp");
  });
});

describe("launch options and the holder command", () => {
  test("mode defaults to terminal, accepts acp, refuses anything else", () => {
    expect(launchOptionsFromRequest({ provider: "codex" })).toMatchObject({ ok: true, mode: "terminal" });
    expect(launchOptionsFromRequest({ provider: "codex", mode: "acp" })).toMatchObject({ ok: true, mode: "acp", remoteControl: false });
    expect(launchOptionsFromRequest({ mode: "chat" }).ok).toBe(false);
  });

  test("the holder command carries no secrets; the bridge's settings go in its environment", () => {
    const dataDir = base();
    const built = buildAcpLaunch({
      dataDir, screen: "cs-chat", cwd: "/srv/my project", argv: ["/opt/bin/codex-acp"],
      mcp: [{ command: "/bun", args: ["x.ts"], env: { CS_COMMUNICATOR_TOKEN: "${CS_COMMUNICATOR_TOKEN}" } }],
      resumeId: "sess-9", autoAllow: true, bunPath: "/usr/bin/bun", bridgePath: "/app/server/acp/bridge.ts",
    });
    if (!built.ok) throw new Error(built.error);
    expect(built.inner).toBe("cd '/srv/my project' && exec '/usr/bin/bun' '/app/server/acp/bridge.ts'");
    expect(built.env).toMatchObject({ CS_ACP_DIR: `${dataDir}/acp/cs-chat`, CS_ACP_ARGV: '["/opt/bin/codex-acp"]', CS_ACP_RESUME: "sess-9", CS_ACP_AUTO_ALLOW: "1" });
    expect(built.env.CS_ACP_MCP).toContain("${CS_COMMUNICATOR_TOKEN}"); // a reference, never the value
  });

  test("a socket path of 100 bytes or more is refused before anything is created", () => {
    const built = buildAcpLaunch({ dataDir: `/${"d".repeat(90)}`, screen: "cs-chat", cwd: "/", argv: ["x"], mcp: [], autoAllow: false });
    expect(built.ok).toBe(false);
  });
});

describe("state mapping", () => {
  const row = { phase: "ready", error_message: null };
  const info = (fields: ReturnType<typeof acpSessionFields>): SessionInfo => ({
    id: "m:cs-chat", kind: "managed", provider: "codex", launchId: "L1", name: "chat", workspace: false, project: "/srv/p", projectLabel: null,
    pid: 1, uptimeSec: 1, cpu: 0, active: false, telemetryUnknown: false, turnState: true, turnComplete: true, mode: "acp", claudeUrl: null, remoteControl: false,
    resumeId: null, model: null, initial: "C", ...fields,
  });
  const st = (state: AcpState["state"], error: string | null = null): AcpState =>
    ({ v: 1, state, acpSessionId: "s", loadSession: true, agent: null, pendingPermissions: 0, error, updatedAt: "" });

  test("a pending permission reads as waiting on you everywhere", () => {
    const s = info(acpSessionFields(st("waiting"), row));
    expect(sessionActivity(s)).toBe("waiting");
    expect(sessionState(s, false)).toBe("asking");
    expect(countActivity([{ status: s.status, activity: sessionActivity(s) }], 0)).toEqual({ working: 0, waiting: 1, terminals: 0 });
  });

  test("working, idle, starting, failed and exited", () => {
    expect(sessionActivity(info(acpSessionFields(st("working"), row)))).toBe("running");
    expect(sessionState(info(acpSessionFields(st("working"), row)), false)).toBe("working");
    expect(sessionActivity(info(acpSessionFields(st("idle"), row)))).toBe("finished");
    expect(sessionState(info(acpSessionFields(st("idle"), row)), false)).toBe("waiting");
    expect(sessionActivity(info(acpSessionFields(null, row)))).toBe("starting");
    const failed = info(acpSessionFields(st("failed", "Authentication required"), row));
    expect(sessionActivity(failed)).toBe("failed");
    expect(failed.errorMessage).toBe("Authentication required");
    expect(sessionActivity(info(acpSessionFields(st("exited"), row)))).toBe("ended");
  });
});

describe("archive", () => {
  test("archiving a Chat launch keeps its mode for resume", () => {
    const database = db();
    acpRow(database);
    const row = database.query("SELECT screen, name, project_path, created_at, claude_url, resume_id, remote_control, provider, launch_id, phase, error_message, resume_archive_id FROM launches").get() as LaunchRow;
    expect(archiveManagedLaunch(database, row, 2, null, "ended")).toBe(true);
    expect(database.query("SELECT mode FROM archive").get()).toEqual({ mode: "acp" });
  });
});

describe("routes", () => {
  function harness(sent: BridgeCommand[] = [], answer = { ok: true } as any) {
    const database = db();
    const dataDir = base();
    return {
      database, dataDir,
      call: (path: string, init?: RequestInit) => handleAcpRoute(new Request(`http://x${path}`, init), {
        database, dataDir, agents: () => [], send: async (_s, c) => { sent.push(c); return answer; },
      }),
    };
  }

  test("GET returns events after the cursor and the bridge's state", async () => {
    const h = harness();
    acpRow(h.database);
    bridgeFiles(h.dataDir, "cs-chat", { state: "working" }, [["user", { text: "hi" }], ["turn_end", { stopReason: "end_turn" }]]);
    const first = await (await h.call("/api/sessions/m%3Acs-chat/acp"))!.json();
    expect(first).toMatchObject({ mode: "acp", state: "working", agent: { name: "fake" } });
    expect(first.events.map((e: any) => e.kind)).toEqual(["user", "turn_end"]);
    const again = await (await h.call(`/api/sessions/m%3Acs-chat/acp?after=${first.cursor}`))!.json();
    expect(again.events).toEqual([]);
  });

  test("terminal sessions and malformed ids are 404, without touching the filesystem", async () => {
    const h = harness();
    h.database.query("INSERT INTO launches (screen, name, project_path, created_at, provider) VALUES ('cs-term', 'term', '/srv/p', 1, 'claude')").run();
    expect((await h.call("/api/sessions/m%3Acs-term/acp"))!.status).toBe(404);
    expect((await h.call("/api/sessions/m%3Acs-..%2F..%2Fetc/acp"))!.status).toBe(404);
    expect((await h.call("/api/sessions/e%3A123/acp"))!.status).toBe(404);
  });

  test("POST forwards a permission answer to the session's own bridge", async () => {
    const sent: BridgeCommand[] = [];
    const h = harness(sent);
    acpRow(h.database);
    bridgeFiles(h.dataDir, "cs-chat", { state: "waiting" });
    const res = await h.call("/api/sessions/m%3Acs-chat/acp", { method: "POST", body: JSON.stringify({ op: "permission", requestId: "perm-1", optionId: "allow-once" }) });
    expect(res!.status).toBe(200);
    expect(sent).toEqual([{ op: "permission", requestId: "perm-1", optionId: "allow-once" }]);
  });

  test("POST relays the bridge's refusal", async () => {
    const h = harness([], { ok: false, error: "That isn't one of the agent's options." });
    acpRow(h.database);
    bridgeFiles(h.dataDir, "cs-chat", { state: "waiting" });
    const res = await h.call("/api/sessions/m%3Acs-chat/acp", { method: "POST", body: JSON.stringify({ op: "permission", requestId: "perm-1", optionId: "zzz" }) });
    expect(res!.status).toBe(422);
    expect((await res!.json()).error).toContain("options");
  });

  test("commands are validated before anything is sent", () => {
    expect(parseAcpCommand({ op: "prompt", text: "  " }).ok).toBe(false);
    expect(parseAcpCommand({ op: "prompt", text: "x".repeat(16 * 1024 + 1) }).ok).toBe(false);
    expect(parseAcpCommand({ op: "permission", requestId: "../x", optionId: "a" }).ok).toBe(false);
    expect(parseAcpCommand({ op: "shell" }).ok).toBe(false);
    expect(parseAcpCommand({ op: "cancel" })).toEqual({ ok: true, command: { op: "cancel" } });
  });
});

describe("MCP I/O for Chat sessions", () => {
  const permissionEvents: Array<[string, Record<string, unknown>]> = [
    ["permission", { requestId: "perm-1", toolCall: { title: "Edit README.md" }, options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ] }],
  ];
  const terminalIo = {
    readScreen: async () => ({ ok: true as const, value: "bridge summary" }),
    sendText: async () => ({ ok: false as const, error: "typed into a terminal" }),
    sendKeys: async () => ({ ok: true as const, value: true as const }),
  };

  function io(state: AcpState["state"], events = permissionEvents) {
    const database = db();
    const dataDir = base();
    acpRow(database);
    const paths = bridgeFiles(dataDir, "cs-chat", { state }, events);
    const sent: BridgeCommand[] = [];
    const wrapped = acpAwareIo(terminalIo, { database, dataDir, send: async (_s, c) => { sent.push(c); return { ok: true }; } });
    return { wrapped, sent, paths };
  }

  test("send_message with an option's name answers the pending permission", async () => {
    const { wrapped, sent } = io("waiting");
    expect(await wrapped.sendText("m:cs-chat", "allow once")).toEqual({ ok: true, value: true });
    expect(sent).toEqual([{ op: "permission", requestId: "perm-1", optionId: "allow-once" }]);
  });

  test("other text while waiting is refused with the options", async () => {
    const { wrapped, sent } = io("waiting");
    const r = await wrapped.sendText("m:cs-chat", "do the thing");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("“Allow once” (allow-once)");
    expect(sent).toEqual([]);
  });

  test("when idle, send_message is a prompt", async () => {
    const { wrapped, sent } = io("idle", []);
    await wrapped.sendText("m:cs-chat", "next task");
    expect(sent).toEqual([{ op: "prompt", text: "next task" }]);
  });

  test("read_session appends the pending request; press_keys is refused", async () => {
    const { wrapped } = io("waiting");
    const screen = await wrapped.readScreen("m:cs-chat", 20);
    expect(screen.ok && screen.value).toContain("Permission requested: Edit README.md");
    expect((await wrapped.sendKeys("m:cs-chat", ["enter"])).ok).toBe(false);
  });

  test("terminal sessions pass straight through", async () => {
    const { wrapped } = io("idle", []);
    expect(await wrapped.sendText("m:cs-other", "hi")).toEqual({ ok: false, error: "typed into a terminal" });
  });

  test("a resolved request is no longer pending", () => {
    const { paths } = io("idle", [...permissionEvents, ["permission_resolved", { requestId: "perm-1", optionId: "reject", auto: false }]]);
    expect(pendingPermissions(paths.events)).toEqual([]);
  });
});
