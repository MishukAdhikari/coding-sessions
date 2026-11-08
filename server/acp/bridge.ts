/**
 * The ACP bridge: runs inside a session's mux holder (zmx, screen or herdr) as
 * `bun server/acp/bridge.ts`, so the agent survives restarts and updates of the
 * Coding Sessions server exactly like a terminal session does.
 *
 * It is the Agent Client Protocol client. It starts the agent's ACP command with
 * stdio pipes, runs initialize and session/new (or session/load to resume), and then:
 *   - appends what the conversation shows to events.jsonl (event-log.ts),
 *   - publishes its state in state.json (starting/working/waiting/idle/exited/failed),
 *   - takes commands — prompt, cancel, permission — on bridge.sock, a 0600 Unix socket.
 * A permission request waits here, in the bridge, so it outlives a server restart.
 *
 * Configuration comes from the environment, never argv:
 *   CS_ACP_DIR         the session's private directory (paths.ts)
 *   CS_ACP_ARGV        JSON array: the agent's ACP command
 *   CS_ACP_CWD         the session folder
 *   CS_ACP_MCP         JSON array of MCP stdio entries whose env values are ${VAR} references
 *   CS_ACP_RESUME      an ACP session id to reopen (optional)
 *   CS_ACP_AUTO_ALLOW  "1": answer permission requests with their allow_once option
 * These are removed before the agent starts; everything else in the environment —
 * credentials included — is the agent's, as it would be in a terminal session.
 *
 * Its own stdout is the holder's terminal: a readable summary for anyone who attaches.
 */
import { chmodSync, lstatSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { createEventWriter, writeState, type AcpState, type BridgeState } from "./event-log";
import { createLineFramer, createPeer, rpcError } from "./jsonrpc";
import { EVENTS_FILE, SOCKET_FILE, STATE_FILE, checkPrivateDir } from "./paths";

const PROTOCOL_VERSION = 1;
const SETUP_TIMEOUT_MS = 120_000;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_AGENT_LINE_BYTES = 32 * 1024 * 1024;

interface PermissionOption { optionId: string; name: string; kind: string }
interface PendingPermission { options: PermissionOption[]; resolve: (outcome: object) => void }

function fail(message: string): never {
  console.error(`acp bridge: ${message}`);
  process.exit(2);
}

function parseJson<T>(raw: string | undefined, what: string): T {
  try { return JSON.parse(raw ?? ""); } catch { return fail(`${what} is not valid JSON.`); }
}

/** `${VAR}` references in an MCP entry become values from this environment; the ACP stdio shape. Pure. */
export function acpMcpServers(entries: unknown, env: Record<string, string | undefined>): Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> {
  if (!Array.isArray(entries)) return [];
  const names = ["coding-sessions", "connectors"];
  return entries.flatMap((entry: any, i) => {
    if (!entry || typeof entry.command !== "string" || !Array.isArray(entry.args)) return [];
    const vars = entry.env && typeof entry.env === "object" ? Object.entries(entry.env as Record<string, unknown>) : [];
    return [{
      name: typeof entry.name === "string" ? entry.name : names[i] ?? `server-${i + 1}`,
      command: entry.command,
      args: entry.args.map(String),
      env: vars.map(([name, value]) => ({
        name,
        value: String(value).replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, v: string) => env[v] ?? ""),
      })),
    }];
  });
}

async function main() {
  const env = process.env;
  const dir = env.CS_ACP_DIR ?? fail("CS_ACP_DIR is not set.");
  const argv = parseJson<string[]>(env.CS_ACP_ARGV, "CS_ACP_ARGV");
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== "string")) fail("CS_ACP_ARGV must be a non-empty list of strings.");
  const cwd = env.CS_ACP_CWD || process.cwd();
  const mcpServers = acpMcpServers(env.CS_ACP_MCP ? parseJson(env.CS_ACP_MCP, "CS_ACP_MCP") : [], env);
  const resumeId = env.CS_ACP_RESUME?.trim() || null;
  const autoAllow = env.CS_ACP_AUTO_ALLOW === "1";

  const checked = checkPrivateDir(dir);
  if (!checked.ok) fail(checked.error);
  const eventsPath = join(dir, EVENTS_FILE);
  const statePath = join(dir, STATE_FILE);
  const socketPath = join(dir, SOCKET_FILE);
  // A fresh launch: the previous launch's log and state are not this conversation's.
  for (const file of [eventsPath, statePath, `${statePath}.tmp`, socketPath]) rmSync(file, { force: true });

  const log = createEventWriter(eventsPath);
  const state: Omit<AcpState, "v" | "updatedAt"> = { state: "starting", acpSessionId: null, loadSession: false, agent: null, pendingPermissions: 0, error: null };
  const pending = new Map<string, PendingPermission>();
  let permissionCounter = 0;
  let turnRunning = false;
  let exiting = false;

  const setState = (next: Partial<typeof state>) => {
    Object.assign(state, next);
    state.pendingPermissions = pending.size;
    if (!exiting || next.state === "exited") writeState(statePath, state);
  };
  const turnState = (): BridgeState => (pending.size ? "waiting" : turnRunning ? "working" : "idle");
  const say = (line: string) => process.stdout.write(`${line}\n`);
  setState({ state: "starting" });

  /* ---------- the agent ---------- */

  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !k.startsWith("CS_ACP_")) childEnv[k] = v;
  say(`Starting ${basename(argv[0]!)} over ACP in ${cwd}`);
  let agent: ReturnType<typeof Bun.spawn>;
  try {
    agent = Bun.spawn(argv, { cwd, env: childEnv, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  } catch (e) {
    const message = `Could not start ${argv[0]}: ${(e as Error).message}`;
    log.append("notice", { level: "error", text: message });
    setState({ state: "failed", error: message });
    say(message);
    return; // stay up so the card can show why; ending the session removes it
  }

  const stdin = agent.stdin as import("bun").FileSink;
  const peer = createPeer({
    write: (line) => { try { stdin.write(`${line}\n`); stdin.flush(); } catch {} },
    onNotification(method, params) {
      if (method !== "session/update" || !params || typeof params.update !== "object") return;
      log.append("update", { update: params.update });
      mirror(params.update);
    },
    async onRequest(method, params) {
      if (method === "session/request_permission") return permission(params);
      // fs/* and terminal/* are not offered (clientCapabilities says so); refuse anything else.
      throw rpcError(-32601, `Method not found: ${method}`);
    },
  });

  function mirror(update: any) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": if (update.content?.type === "text") process.stdout.write(String(update.content.text)); break;
      case "tool_call": say(`\n• ${update.title ?? "Tool call"} [${update.status ?? "pending"}]`); break;
      case "tool_call_update": if (update.status) say(`  ${update.toolCallId}: ${update.status}`); break;
      case "plan": say(`\nPlan: ${(update.entries ?? []).map((e: any) => `[${e.status === "completed" ? "x" : " "}] ${e.content}`).join("  ")}`); break;
    }
  }

  function permission(params: any): Promise<object> {
    const options: PermissionOption[] = (Array.isArray(params?.options) ? params.options : [])
      .filter((o: any) => o && typeof o.optionId === "string" && typeof o.name === "string")
      .map((o: any) => ({ optionId: o.optionId, name: o.name, kind: String(o.kind ?? "") }));
    const requestId = `perm-${++permissionCounter}`;
    log.append("permission", { requestId, toolCall: params?.toolCall ?? null, options });
    const auto = autoAllow ? options.find((o) => o.kind === "allow_once") : undefined;
    if (auto) {
      log.append("permission_resolved", { requestId, optionId: auto.optionId, auto: true });
      say(`\n? ${params?.toolCall?.title ?? "Permission"}: ${auto.name} (automatic)`);
      return Promise.resolve({ outcome: { outcome: "selected", optionId: auto.optionId } });
    }
    say(`\n? Permission needed: ${params?.toolCall?.title ?? "a tool call"} — answer in the chat`);
    return new Promise((resolve) => {
      pending.set(requestId, { options, resolve });
      setState({ state: turnState() });
    });
  }

  function resolvePermission(requestId: string, optionId: string | null) {
    const p = pending.get(requestId);
    if (!p) return;
    pending.delete(requestId);
    p.resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
    log.append("permission_resolved", optionId ? { requestId, optionId, auto: false } : { requestId, outcome: "cancelled", auto: false });
  }

  const framer = createLineFramer(MAX_AGENT_LINE_BYTES, (n) => log.append("notice", { level: "warning", text: `Skipped a ${n}-byte message from the agent.` }));
  (async () => {
    for await (const chunk of agent.stdout as ReadableStream<Uint8Array>) for (const line of framer.push(chunk)) peer.handleLine(line);
  })().catch(() => {});

  /* ---------- the command socket ---------- */

  const umask = process.umask(0o077);
  let listener: ReturnType<typeof Bun.listen>;
  try {
    listener = Bun.listen<{ framer: ReturnType<typeof createLineFramer> }>({
      unix: socketPath,
      socket: {
        open(socket) { socket.data = { framer: createLineFramer(MAX_COMMAND_BYTES) }; },
        data(socket, chunk) {
          for (const line of socket.data.framer.push(chunk)) {
            let msg: any;
            try { msg = JSON.parse(line); } catch { socket.write(`${JSON.stringify({ ok: false, error: "Not JSON." })}\n`); continue; }
            const answer = command(msg);
            socket.write(`${JSON.stringify({ id: msg?.id ?? null, ...answer })}\n`);
          }
        },
      },
    });
  } finally {
    process.umask(umask);
  }
  chmodSync(socketPath, 0o600);
  const sock = lstatSync(socketPath);
  if (!sock.isSocket() || (sock.mode & 0o777) !== 0o600) fail(`Could not make ${socketPath} private.`);

  function command(msg: any): { ok: true; [k: string]: unknown } | { ok: false; error: string } {
    switch (msg?.op) {
      case "ping":
        return { ok: true, state: state.state };
      case "prompt": {
        const text = typeof msg.text === "string" ? msg.text : "";
        if (!text.trim()) return { ok: false, error: "Type a message first." };
        if (state.state === "starting") return { ok: false, error: "The agent is still starting." };
        if (state.state === "failed") return { ok: false, error: state.error ?? "The agent failed to start." };
        if (state.state === "exited") return { ok: false, error: "The agent has exited." };
        if (turnRunning) return { ok: false, error: "The agent is still working on the last message. Stop it first, or wait." };
        startTurn(text);
        return { ok: true };
      }
      case "cancel": {
        if (!turnRunning) return { ok: false, error: "Nothing is running." };
        for (const id of [...pending.keys()]) resolvePermission(id, null);
        peer.notify("session/cancel", { sessionId: state.acpSessionId });
        setState({ state: turnState() });
        say("\n(stop requested)");
        return { ok: true };
      }
      case "permission": {
        const p = pending.get(String(msg.requestId ?? ""));
        if (!p) return { ok: false, error: "That request was already answered." };
        if (!p.options.some((o) => o.optionId === msg.optionId)) return { ok: false, error: "That isn't one of the agent's options." };
        resolvePermission(String(msg.requestId), String(msg.optionId));
        setState({ state: turnState() });
        return { ok: true };
      }
      default:
        return { ok: false, error: "Unknown command." };
    }
  }

  function startTurn(text: string) {
    turnRunning = true;
    log.append("user", { text });
    say(`\n› ${text}\n`);
    setState({ state: "working" });
    peer.request("session/prompt", { sessionId: state.acpSessionId, prompt: [{ type: "text", text }] })
      .then((result: any) => {
        log.append("turn_end", { stopReason: typeof result?.stopReason === "string" ? result.stopReason : "end_turn" });
        say(`\n— ${result?.stopReason ?? "end_turn"}`);
      })
      .catch((e: Error) => {
        if (exiting) return;
        log.append("turn_end", { error: e.message });
        say(`\n— error: ${e.message}`);
      })
      .finally(() => {
        turnRunning = false;
        for (const id of [...pending.keys()]) resolvePermission(id, null);
        if (!exiting && state.state !== "failed") setState({ state: turnState() });
      });
  }

  /* ---------- lifecycle ---------- */

  const shutdown = (code: number, why: string) => {
    if (exiting) return;
    exiting = true;
    for (const id of [...pending.keys()]) resolvePermission(id, null);
    peer.close(why);
    log.append("notice", { level: "info", text: why });
    setState({ state: "exited" });
    log.close();
    try { listener.stop(true); } catch {}
    rmSync(socketPath, { force: true });
    say(`\n${why}`);
    process.exit(code);
  };
  agent.exited.then((code) => shutdown(code ?? 0, `The agent exited${code ? ` with code ${code}` : ""}.`));
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(sig, () => {
      try { agent.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { agent.kill("SIGKILL"); } catch {} shutdown(0, "The session was ended."); }, 3000).unref?.();
    });
  }

  /* ---------- setup ---------- */

  try {
    const init: any = await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "coding-sessions", title: "Coding Sessions", version: "1" },
    }, SETUP_TIMEOUT_MS);
    const info = init?.agentInfo ?? {};
    const agentInfo = {
      name: typeof info.name === "string" ? info.name : null,
      title: typeof info.title === "string" ? info.title : null,
      version: typeof info.version === "string" ? info.version : null,
    };
    const loadSession = init?.agentCapabilities?.loadSession === true;
    log.append("status", { agent: agentInfo, loadSession, protocolVersion: init?.protocolVersion ?? null });
    setState({ agent: agentInfo, loadSession });
    say(`Connected to ${agentInfo.title ?? agentInfo.name ?? "the agent"}${agentInfo.version ? ` ${agentInfo.version}` : ""}.`);

    let sessionId: string | null = null;
    if (resumeId && loadSession) {
      try {
        await peer.request("session/load", { sessionId: resumeId, cwd, mcpServers }, SETUP_TIMEOUT_MS);
        sessionId = resumeId;
      } catch (e) {
        log.append("notice", { level: "warning", text: `The earlier conversation could not be reopened (${(e as Error).message}), so this is a new conversation in the same folder.` });
      }
    } else if (resumeId) {
      log.append("notice", { level: "warning", text: `${agentInfo.title ?? agentInfo.name ?? "This agent"} can't reopen earlier conversations, so this is a new conversation in the same folder.` });
    }
    if (!sessionId) {
      const created: any = await peer.request("session/new", { cwd, mcpServers }, SETUP_TIMEOUT_MS);
      if (typeof created?.sessionId !== "string") throw new Error("The agent did not return a session id.");
      sessionId = created.sessionId;
    }
    setState({ acpSessionId: sessionId, state: turnState() });
    say("Ready. Send messages from the chat in Coding Sessions.");
  } catch (e) {
    if (exiting) return;
    const message = (e as Error).message || "The agent failed to start a session.";
    log.append("notice", { level: "error", text: `The agent could not start a session: ${message}` });
    setState({ state: "failed", error: message });
    say(`Setup failed: ${message}`);
  }
}

if (import.meta.main) await main();
