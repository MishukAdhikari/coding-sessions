/**
 * herdr (github.com/herdrdev/herdr, v0.9.5) as a session holder, opt-in with `CS_MUX=herdr`.
 *
 * The app runs its own herdr session, `coding-sessions`, so the operator's default herdr is
 * never touched. Each launch is one pane in a tab of the `coding-sessions` workspace, labelled
 * with the launch's screen name (`cs-<name>`, `webterm-<id>`), so ids stay backend-neutral.
 *
 * Everything that carries data goes over herdr's Unix socket (mode 0600, no TCP listener):
 * newline-delimited JSON, one request per connection. The per-launch environment — stored
 * secrets, communicator tokens — travels in the request's `env` object, never as
 * `--env KEY=VALUE` on a command line, where `ps` would show it.
 *
 * herdr restores a stopped server's panes as bare login shells under the same labels. Those
 * are not our sessions: a pane counts as live only while it carries the launch token set at
 * spawn, which herdr does not restore.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readCsSetting } from "./environment";
import { childEnvironment } from "./child-env";

export const HERDR_SESSION = "coding-sessions";
export const HERDR_WORKSPACE = "coding-sessions";
const TOKEN = "cs_launch";
const SOURCE = "coding-sessions";
const LABEL = /^(?:cs-|webterm-)/;
const ENDED_ARGV = ["sh", "-c", 'echo "This session has ended."; exit 1'];

export type HerdrReply = { ok: true; result: any } | { ok: false; code: string; message: string };
export interface HerdrPane { name: string; paneId: string; terminalId: string }
export interface HerdrSession { name: string; pid: number | null; backend: "herdr"; paneId: string; terminalId: string }
type Env = Record<string, string | undefined>;

/**
 * App-owned config, passed to every herdr process as HERDR_CONFIG_PATH. No background calls
 * to herdr.dev; no agent resume of its own (a restored pane is an ended session here); and
 * the prefix moves off ctrl+b, which the attach client would otherwise swallow — agents
 * such as Claude Code use ctrl+b.
 */
export function herdrConfigToml(): string {
  return [
    "# Written by Coding Sessions for its own herdr session. Changes are overwritten.",
    "[update]", "version_check = false", "manifest_check = false", "",
    "[session]", "resume_agents_on_restore = false", "",
    "[keys]", 'prefix = "f12"', "",
  ].join("\n");
}

/** One line of herdr's socket protocol → reply. Pure, for tests. */
export function parseReply(line: string): HerdrReply {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return { ok: false, code: "malformed", message: "herdr sent a reply that is not JSON" }; }
  if (msg?.error) return { ok: false, code: String(msg.error.code ?? "error"), message: String(msg.error.message ?? "herdr error") };
  if (msg && typeof msg === "object" && "result" in msg) return { ok: true, result: msg.result };
  return { ok: false, code: "malformed", message: "herdr sent a reply without a result" };
}

/** `herdr session list --json` → that session's socket path. Pure, for tests. */
export function parseSessionSocket(out: string, session = HERDR_SESSION): string | null {
  try {
    const row = (JSON.parse(out)?.sessions ?? []).find((s: any) => s?.name === session);
    return typeof row?.socket_path === "string" && row.socket_path.startsWith("/") ? row.socket_path : null;
  } catch { return null; }
}

/**
 * `pane.list` result → our live panes, plus orphans: panes under one of our labels without
 * the launch token (restored by herdr after a restart, or left by a failed spawn). Pure.
 */
export function parseHerdrPanes(result: any): { live: HerdrPane[]; orphans: Array<{ name: string; paneId: string }> } {
  const live: HerdrPane[] = [];
  const orphans: Array<{ name: string; paneId: string }> = [];
  for (const p of Array.isArray(result?.panes) ? result.panes : []) {
    if (typeof p?.label !== "string" || !LABEL.test(p.label) || typeof p.pane_id !== "string") continue;
    if (p.tokens?.[TOKEN] === p.label && typeof p.terminal_id === "string") live.push({ name: p.label, paneId: p.pane_id, terminalId: p.terminal_id });
    else orphans.push({ name: p.label, paneId: p.pane_id });
  }
  return { live, orphans };
}

/** `pane.process_info` result → the pane's root process (the `bash -lc` we launched, or what it exec'd). Pure. */
export function parseShellPid(result: any): number | null {
  const pid = result?.process_info?.shell_pid;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** `pane.read` result → text. Pure. */
export function parseReadText(result: any): string | null {
  return typeof result?.read?.text === "string" ? result.read.text : null;
}

/**
 * `layout.apply` params for one launch: a new tab holding a single pane that runs
 * `bash -lc <inner>`. The environment rides only in `root.env`. Pure, for tests.
 */
export function launchParams(
  target: { workspaceId: string } | { tabId: string },
  name: string, inner: string, env: Record<string, string>, cwd: string,
): Record<string, unknown> {
  // herdr rejects workspace_id and tab_id together; tab_id replaces that tab.
  const where = "tabId" in target ? { tab_id: target.tabId } : { workspace_id: target.workspaceId };
  return { ...where, tab_label: name, focus: false, root: { type: "pane", label: name, cwd, command: ["bash", "-lc", inner], env } };
}

/** The command a ttyd bridge runs to join a pane: herdr's direct terminal attach. Pure. */
export function herdrAttachArgv(bin: string, terminalId: string | undefined, configPath: string): string[] {
  // No terminal id means no live pane. Terminal ids are never reused, so a ttyd reconnect
  // after the pane ended fails ("not found") instead of joining or starting something else.
  // --takeover: one client per terminal; the newest browser tab wins over a stale one.
  if (!terminalId || !/^term_[0-9a-f]+$/.test(terminalId)) return ENDED_ARGV;
  return ["env", `HERDR_CONFIG_PATH=${configPath}`, bin, "--session", HERDR_SESSION, "terminal", "attach", terminalId, "--takeover"];
}

/** The long-lived server's own environment: just enough to run. Panes get theirs per launch. */
export function serverEnvironment(configPath: string, source: Env = process.env): Record<string, string> {
  const keep = new Set(["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LANGUAGE", "TZ", "TMPDIR"]);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (keep.has(name) || /^LC_[A-Z_]+$/.test(name) || /^XDG_[A-Z_]+$/.test(name))) env[name] = value;
  }
  env.HERDR_CONFIG_PATH = configPath;
  return env;
}

/** One request on its own connection: herdr answers once, then closes. */
export function socketRequest(path: string, method: string, params: object, timeoutMs = 3000): Promise<HerdrReply> {
  return new Promise((done) => {
    let buf = "";
    let pending = Buffer.from(JSON.stringify({ id: "cs", method, params }) + "\n");
    let settled = false;
    let sock: { end(): void } | null = null;
    const decoder = new TextDecoder();
    const finish = (reply: HerdrReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock?.end(); } catch {}
      done(reply);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "timeout", message: `herdr did not answer ${method}` }), timeoutMs);
    const flush = (s: { write(b: Uint8Array): number }) => {
      // A large env can exceed one write; send the rest on drain.
      const n = s.write(pending);
      pending = pending.subarray(Math.max(0, n));
    };
    Bun.connect({
      unix: path,
      socket: {
        open(s) { flush(s); },
        drain(s) { if (pending.length) flush(s); },
        data(_s, chunk) {
          buf += decoder.decode(chunk, { stream: true });
          const nl = buf.indexOf("\n");
          if (nl >= 0) finish(parseReply(buf.slice(0, nl)));
        },
        close() { finish(buf.trim() ? parseReply(buf) : { ok: false, code: "malformed", message: "herdr closed the connection" }); },
        error(_s, e) { finish({ ok: false, code: "malformed", message: String(e?.message ?? e) }); },
      },
    }).then((s) => { sock = s; if (settled) s.end(); }, (e: any) => {
      // No socket file, or nobody listening on it: the server is down.
      const down = e?.code === "ENOENT" || e?.code === "ECONNREFUSED";
      finish({ ok: false, code: down ? "server_not_running" : "connect_failed", message: String(e?.message ?? e) });
    });
  });
}

async function runCapture(argv: string[], env: Env): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out, err };
  } catch (e) {
    return { code: 127, out: "", err: String((e as Error)?.message ?? e) };
  }
}

export interface HerdrDeps {
  /** Send one request to the server at `socket`. */
  request(socket: string, method: string, params: object, timeoutMs?: number): Promise<HerdrReply>;
  /** Run a herdr CLI command to completion. */
  run(argv: string[], env: Env): Promise<{ code: number; out: string; err: string }>;
  /** Start a process detached from this one (the herdr server outlives app restarts). */
  start(argv: string[], env: Record<string, string>): void;
  /** Make sure the app's herdr config exists; returns its path. */
  config(): string;
  sleep(ms: number): Promise<void>;
}

function writeConfig(): string {
  const dir = resolve(readCsSetting(process.env, "CS_RUNTIME_DIR") ?? join(homedir(), ".local", "state", "coding-sessions"));
  const file = join(dir, "herdr.toml");
  const text = herdrConfigToml();
  let current: string | null = null;
  try { current = readFileSync(file, "utf8"); } catch {}
  if (current !== text) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, text, { mode: 0o600 });
  }
  return file;
}

const defaultDeps: HerdrDeps = {
  request: socketRequest,
  run: runCapture,
  start(argv, env) {
    const p = Bun.spawn(argv, { cwd: env.HOME ?? homedir(), env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    p.unref();
  },
  config: writeConfig,
  sleep: (ms) => Bun.sleep(ms),
};

export function createHerdr(bin: string, deps: HerdrDeps = defaultDeps) {
  let socket: string | null = null;
  let lastGood: HerdrSession[] | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const cliEnv = (): Env => ({ ...childEnvironment(), HERDR_CONFIG_PATH: deps.config() });

  async function socketPath(): Promise<string> {
    if (socket) return socket;
    const r = await deps.run([bin, "session", "list", "--json"], cliEnv());
    const found = r.code === 0 ? parseSessionSocket(r.out) : null;
    if (found) socket = found;
    return found ?? join(homedir(), ".config", "herdr", "sessions", HERDR_SESSION, "herdr.sock");
  }

  async function request(method: string, params: object, timeoutMs?: number): Promise<HerdrReply> {
    return deps.request(await socketPath(), method, params, timeoutMs);
  }

  /** One at a time: a pane is untokened between layout.apply and report_metadata, and a
   *  concurrent spawn's orphan sweep would close it. */
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  async function ensureServer(): Promise<{ ok: true } | { ok: false; err: string }> {
    const ping = await request("ping", {});
    if (ping.ok) return { ok: true };
    // A busy server must not get a second one started next to it.
    if (ping.code !== "server_not_running") return { ok: false, err: ping.message };
    const configPath = deps.config();
    deps.start([bin, "--session", HERDR_SESSION, "server"], serverEnvironment(configPath));
    for (let i = 0; i < 50; i++) {
      await deps.sleep(100);
      socket = null; // its path is known once the server has created the session directory
      if ((await request("ping", {})).ok) return { ok: true };
    }
    return { ok: false, err: "The herdr server did not start." };
  }

  async function closePanes(paneIds: string[]): Promise<void> {
    await Promise.all(paneIds.map((pane_id) => request("pane.close", { pane_id })));
  }

  async function apply(name: string, inner: string, env: Record<string, string>, cwd: string): Promise<HerdrReply> {
    const spaces = await request("workspace.list", {});
    const space = spaces.ok ? (spaces.result?.workspaces ?? []).find((w: any) => w?.label === HERDR_WORKSPACE) : null;
    if (space?.workspace_id) {
      const r = await request("layout.apply", launchParams({ workspaceId: space.workspace_id }, name, inner, env, cwd), 10_000);
      // Its last tab closed between the two calls, and herdr never reuses a workspace id.
      if (r.ok || r.code !== "workspace_not_found") return r;
    }
    const created = await request("workspace.create", { label: HERDR_WORKSPACE, cwd, focus: false }, 10_000);
    if (!created.ok) return created;
    const tabId = created.result?.tab?.tab_id;
    if (typeof tabId !== "string") return { ok: false, code: "malformed", message: "herdr created a workspace without a tab" };
    // Replacing the root tab leaves no idle shell behind in the workspace.
    return request("layout.apply", launchParams({ tabId }, name, inner, env, cwd), 10_000);
  }

  return {
    /** Live launches, each with its pane's root pid. See KTD9: a server that is down lists
     *  nothing; one that does not answer keeps the last good listing, or throws before any. */
    async list(): Promise<HerdrSession[]> {
      const r = await request("pane.list", {});
      if (!r.ok) {
        if (r.code === "server_not_running") return (lastGood = []);
        if (lastGood) return lastGood;
        throw new Error(`herdr: ${r.message}`);
      }
      const { live } = parseHerdrPanes(r.result);
      const pids = await Promise.all(live.map(async (p) => {
        const info = await request("pane.process_info", { pane_id: p.paneId });
        return info.ok ? parseShellPid(info.result) : null;
      }));
      return (lastGood = live.map((p, i) => ({ ...p, pid: pids[i] ?? null, backend: "herdr" as const })));
    },

    spawn(name: string, inner: string, opts: { env?: Record<string, string>; cwd?: string } = {}): Promise<{ code: number; out: string; err: string }> {
      return serialized(async () => {
        const fail = (err: string) => ({ code: 1, out: "", err });
        const server = await ensureServer();
        if (!server.ok) return fail(server.err);
        const panes = await request("pane.list", {});
        if (panes.ok) await closePanes(parseHerdrPanes(panes.result).orphans.map((o) => o.paneId));
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(childEnvironment(opts.env))) if (v !== undefined) env[k] = v;
        const applied = await apply(name, inner, env, opts.cwd ?? process.cwd());
        if (!applied.ok) return fail(applied.message);
        const paneId = applied.result?.layout?.root?.pane_id;
        if (typeof paneId !== "string") return fail("herdr did not report the new pane.");
        const marked = await request("pane.report_metadata", { pane_id: paneId, source: SOURCE, tokens: { [TOKEN]: name } });
        if (!marked.ok) {
          await closePanes([paneId]);
          return fail(marked.message);
        }
        return { code: 0, out: "", err: "" };
      });
    },

    /** Close every pane under `name`, ours or a restored leftover. */
    async quit(name: string): Promise<void> {
      const r = await request("pane.list", {});
      if (!r.ok) return;
      const { live, orphans } = parseHerdrPanes(r.result);
      await closePanes([...live, ...orphans].filter((p) => p.name === name).map((p) => p.paneId));
    },

    async read(paneId: string, source: "recent" | "visible", lines?: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
      const r = await request("pane.read", { pane_id: paneId, source, ...(lines ? { lines } : {}) });
      const text = r.ok ? parseReadText(r.result) : null;
      return text === null ? { ok: false, error: r.ok ? "herdr sent no text" : r.message } : { ok: true, text };
    },

    /** Raw bytes, as `zmx send` takes them: herdr passes paste markers, CR and escapes through. */
    async write(paneId: string, bytes: string): Promise<{ ok: true } | { ok: false; error: string }> {
      const r = await request("pane.send_text", { pane_id: paneId, text: bytes });
      return r.ok ? { ok: true } : { ok: false, error: r.message };
    },

    attachArgv(terminalId: string | undefined): string[] {
      return herdrAttachArgv(bin, terminalId, deps.config());
    },
  };
}

export type Herdr = ReturnType<typeof createHerdr>;
