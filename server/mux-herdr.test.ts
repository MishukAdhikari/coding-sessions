import { expect, test } from "bun:test";
import {
  createHerdr, herdrAttachArgv, herdrConfigToml, launchParams, parseHerdrPanes, parseReadText, parseReply,
  parseSessionSocket, parseShellPid, serverEnvironment, type HerdrDeps, type HerdrReply,
} from "./mux-herdr";

// Shapes captured from herdr 0.9.5 (protocol 22).
const pane = (id: string, terminal: string, label?: string, token?: string) => ({
  pane_id: id, terminal_id: terminal, workspace_id: "w1", tab_id: "w1:t2", focused: false, cwd: "/srv",
  agent_status: "unknown", revision: 0, ...(label ? { label } : {}), ...(token ? { tokens: { cs_launch: token } } : {}),
});

test("pane.list → live launches carry our token; restored or half-made panes are orphans", () => {
  const result = {
    type: "pane_list",
    panes: [
      pane("w1:p1", "term_aa", undefined),             // a workspace's own shell: not ours
      pane("w1:p2", "term_bb", "cs-a", "cs-a"),       // live launch
      pane("w1:p3", "term_cc", "cs-b"),               // restored after a herdr restart: no token
      pane("w1:p4", "term_dd", "webterm-ab12", "webterm-ab12"),
      pane("w1:p5", "term_ee", "notes", "notes"),     // a label outside our prefixes
      pane("w1:p6", "term_ff", "cs-c", "cs-other"),   // token for another name
    ],
  };
  expect(parseHerdrPanes(result)).toEqual({
    live: [
      { name: "cs-a", paneId: "w1:p2", terminalId: "term_bb" },
      { name: "webterm-ab12", paneId: "w1:p4", terminalId: "term_dd" },
    ],
    orphans: [{ name: "cs-b", paneId: "w1:p3" }, { name: "cs-c", paneId: "w1:p6" }],
  });
  expect(parseHerdrPanes(undefined)).toEqual({ live: [], orphans: [] });
  expect(parseHerdrPanes({ panes: "junk" })).toEqual({ live: [], orphans: [] });
});

test("pane.process_info → the pane's root pid; anything else → unknown", () => {
  const info = { type: "pane_process_info", process_info: { pane_id: "w1:p2", shell_pid: 56975, foreground_process_group_id: 56975, foreground_processes: [{ pid: 56975, name: "sleep" }] } };
  expect(parseShellPid(info)).toBe(56975);
  expect(parseShellPid({ process_info: { pane_id: "w1:p2" } })).toBeNull();
  expect(parseShellPid({ process_info: { shell_pid: 0 } })).toBeNull();
  expect(parseShellPid(null)).toBeNull();
});

test("replies, session list and pane.read parse; errors keep herdr's code", () => {
  expect(parseReply('{"id":"cs","result":{"type":"pong"}}')).toEqual({ ok: true, result: { type: "pong" } });
  expect(parseReply('{"id":"cs","error":{"code":"workspace_not_found","message":"workspace w1 not found"}}'))
    .toEqual({ ok: false, code: "workspace_not_found", message: "workspace w1 not found" });
  expect(parseReply("not json").ok).toBe(false);
  const sessions = JSON.stringify({ sessions: [
    { default: true, name: "default", running: false, socket_path: "/home/u/.config/herdr/herdr.sock" },
    { default: false, name: "coding-sessions", running: true, socket_path: "/home/u/.config/herdr/sessions/coding-sessions/herdr.sock" },
  ] });
  expect(parseSessionSocket(sessions)).toBe("/home/u/.config/herdr/sessions/coding-sessions/herdr.sock");
  expect(parseSessionSocket(JSON.stringify({ sessions: [] }))).toBeNull();
  expect(parseSessionSocket("garbage")).toBeNull();
  expect(parseReadText({ type: "pane_read", read: { pane_id: "w1:p2", text: "hi\n", truncated: true } })).toBe("hi\n");
  expect(parseReadText({})).toBeNull();
});

test("a launch's env rides only in the pane node, never in its command", () => {
  const params = launchParams({ workspaceId: "w1" }, "cs-a", "exec claude", { OPENAI_API_KEY: "sk-secret" }, "/srv/a");
  expect(params).toEqual({
    workspace_id: "w1", tab_label: "cs-a", focus: false,
    root: { type: "pane", label: "cs-a", cwd: "/srv/a", command: ["bash", "-lc", "exec claude"], env: { OPENAI_API_KEY: "sk-secret" } },
  });
  // herdr rejects workspace_id and tab_id together; tab_id replaces that tab.
  const replace = launchParams({ tabId: "w1:t1" }, "cs-a", "exec claude", {}, "/srv/a");
  expect(replace.tab_id).toBe("w1:t1");
  expect("workspace_id" in replace).toBe(false);
});

test("attach joins one terminal with the app's config; without a live terminal it ends", () => {
  expect(herdrAttachArgv("/usr/local/bin/herdr", "term_65fb38d7f491c3", "/run/cs/herdr.toml")).toEqual([
    "env", "HERDR_CONFIG_PATH=/run/cs/herdr.toml", "/usr/local/bin/herdr", "--session", "coding-sessions",
    "terminal", "attach", "term_65fb38d7f491c3", "--takeover",
  ]);
  for (const id of [undefined, "", "term_x; rm -rf /", "--takeover"]) {
    const argv = herdrAttachArgv("/usr/local/bin/herdr", id, "/run/cs/herdr.toml");
    expect(argv[0]).toBe("sh");
    expect(argv.join(" ")).toContain("exit 1");
  }
});

test("the app's herdr config makes no herdr.dev calls, resumes nothing, and frees ctrl+b", () => {
  const toml = herdrConfigToml();
  expect(toml).toContain("version_check = false");
  expect(toml).toContain("manifest_check = false");
  expect(toml).toContain("resume_agents_on_restore = false");
  expect(toml).toContain('prefix = "f12"');
});

test("the long-lived server starts with a minimal env, not the app's credentials", () => {
  const env = serverEnvironment("/run/cs/herdr.toml", {
    HOME: "/home/u", PATH: "/usr/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", XDG_RUNTIME_DIR: "/run/user/1",
    OPENAI_API_KEY: "sk-secret", CS_PASSTHROUGH_ENV: "OPENAI_API_KEY", GH_TOKEN: "ghp_x",
  });
  expect(env).toEqual({
    HOME: "/home/u", PATH: "/usr/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", XDG_RUNTIME_DIR: "/run/user/1",
    HERDR_CONFIG_PATH: "/run/cs/herdr.toml",
  });
});

/** A scripted herdr server: `handle` answers each request; every request and argv is kept. */
function fakeHerdr(handle: (method: string, params: any) => HerdrReply | Promise<HerdrReply>) {
  const requests: Array<{ method: string; params: any }> = [];
  const runs: Array<{ argv: string[]; env: Record<string, string | undefined> }> = [];
  const starts: Array<{ argv: string[]; env: Record<string, string> }> = [];
  const deps: HerdrDeps = {
    async request(_socket, method, params) { requests.push({ method, params }); return handle(method, params); },
    async run(argv, env) {
      runs.push({ argv, env });
      return { code: 0, out: JSON.stringify({ sessions: [{ name: "coding-sessions", socket_path: "/h/.config/herdr/sessions/coding-sessions/herdr.sock" }] }), err: "" };
    },
    start(argv, env) { starts.push({ argv, env }); },
    config: () => "/run/cs/herdr.toml",
    sleep: async () => {},
  };
  return { herdr: createHerdr("/usr/local/bin/herdr", deps), deps, requests, runs, starts };
}
const ok = (result: any): HerdrReply => ({ ok: true, result });
const err = (code: string): HerdrReply => ({ ok: false, code, message: code });

test("spawn: sweeps orphans, launches in the app's workspace, then marks the pane live; secrets stay off every argv", async () => {
  const secret = "sk-live-very-secret";
  let n = 0;
  const f = fakeHerdr((method) => {
    if (method === "ping") return ok({ type: "pong", protocol: 22 });
    if (method === "pane.list") return ok({ panes: [pane("w1:p3", "term_cc", "cs-old")] });
    if (method === "workspace.list") return ok({ workspaces: [{ workspace_id: "w1", label: "coding-sessions" }] });
    if (method === "layout.apply") return ok({ type: "layout_apply", layout: { root: { type: "pane", pane_id: `w1:p${9 + n++}` } } });
    return ok({ type: "ok" });
  });
  expect(await f.herdr.spawn("cs-a", "exec claude", { env: { OPENAI_API_KEY: secret }, cwd: "/srv/a" })).toEqual({ code: 0, out: "", err: "" });
  expect(f.requests.map((r) => r.method)).toEqual(["ping", "pane.list", "pane.close", "workspace.list", "layout.apply", "pane.report_metadata"]);
  expect(f.requests[2]!.params).toEqual({ pane_id: "w1:p3" });
  const apply = f.requests[4]!.params;
  expect(apply.workspace_id).toBe("w1");
  expect(apply.root.env.OPENAI_API_KEY).toBe(secret);
  expect(apply.root.command).toEqual(["bash", "-lc", "exec claude"]);
  expect(f.requests[5]!.params).toEqual({ pane_id: "w1:p9", source: "coding-sessions", tokens: { cs_launch: "cs-a" } });
  // The secret appears in exactly one place: the launch request's env object.
  for (const { argv, env } of f.runs) {
    expect(argv.join(" ")).not.toContain(secret);
    expect(env.HERDR_CONFIG_PATH).toBe("/run/cs/herdr.toml");
  }
  const outside = f.requests.map((r, i) => (i === 4 ? { ...r, params: { ...r.params, root: { ...r.params.root, env: {} } } } : r));
  expect(JSON.stringify(outside)).not.toContain(secret);
});

test("spawn with no workspace creates one and replaces its root tab; a workspace that just closed is recreated", async () => {
  const f = fakeHerdr((method, params) => {
    if (method === "ping") return ok({ type: "pong" });
    if (method === "pane.list") return ok({ panes: [] });
    if (method === "workspace.list") return ok({ workspaces: [{ workspace_id: "w1", label: "coding-sessions" }] });
    if (method === "layout.apply") return params.workspace_id ? err("workspace_not_found") : ok({ layout: { root: { pane_id: "w2:p2" } } });
    if (method === "workspace.create") return ok({ workspace: { workspace_id: "w2" }, tab: { tab_id: "w2:t1" }, root_pane: { pane_id: "w2:p1" } });
    return ok({ type: "ok" });
  });
  expect((await f.herdr.spawn("cs-a", "exec claude")).code).toBe(0);
  expect(f.requests.map((r) => r.method)).toEqual(["ping", "pane.list", "workspace.list", "layout.apply", "workspace.create", "layout.apply", "pane.report_metadata"]);
  expect(f.requests[5]!.params.tab_id).toBe("w2:t1");
  expect(f.requests[5]!.params.workspace_id).toBeUndefined();
});

test("spawn starts the app's own server when none runs, with the minimal env", async () => {
  let up = false;
  const f = fakeHerdr((method) => {
    if (method === "ping") return up ? ok({ type: "pong" }) : err("server_not_running");
    if (method === "pane.list") return ok({ panes: [] });
    if (method === "workspace.list") return ok({ workspaces: [] });
    if (method === "workspace.create") return ok({ tab: { tab_id: "w1:t1" } });
    if (method === "layout.apply") return ok({ layout: { root: { pane_id: "w1:p2" } } });
    return ok({ type: "ok" });
  });
  const realStart = f.deps.start;
  f.deps.start = (argv, env) => { realStart(argv, env); up = true; };
  expect((await f.herdr.spawn("cs-a", "exec claude", { env: { OPENAI_API_KEY: "sk-x" } })).code).toBe(0);
  expect(f.starts).toHaveLength(1);
  expect(f.starts[0]!.argv).toEqual(["/usr/local/bin/herdr", "--session", "coding-sessions", "server"]);
  expect(f.starts[0]!.env.HERDR_CONFIG_PATH).toBe("/run/cs/herdr.toml");
  expect(JSON.stringify(f.starts[0]!.env)).not.toContain("sk-x");
});

test("a busy server gets no second server started next to it", async () => {
  const f = fakeHerdr(() => err("timeout"));
  expect((await f.herdr.spawn("cs-a", "exec claude")).code).toBe(1);
  expect(f.starts).toHaveLength(0);
});

test("a pane that cannot be marked live is closed, and the launch fails", async () => {
  const f = fakeHerdr((method) => {
    if (method === "workspace.list") return ok({ workspaces: [{ workspace_id: "w1", label: "coding-sessions" }] });
    if (method === "pane.list") return ok({ panes: [] });
    if (method === "layout.apply") return ok({ layout: { root: { pane_id: "w1:p7" } } });
    if (method === "pane.report_metadata") return err("invalid_params");
    return ok({ type: "ok" });
  });
  expect((await f.herdr.spawn("cs-a", "exec claude")).code).toBe(1);
  expect(f.requests.at(-1)).toEqual({ method: "pane.close", params: { pane_id: "w1:p7" } });
});

test("overlapping spawns run one at a time, so neither sweeps the other's unmarked pane", async () => {
  const panes: any[] = [];
  let next = 2;
  const f = fakeHerdr(async (method, params) => {
    if (method === "pane.list") return ok({ panes: [...panes] });
    if (method === "workspace.list") return ok({ workspaces: [{ workspace_id: "w1", label: "coding-sessions" }] });
    if (method === "layout.apply") {
      const id = `w1:p${next++}`;
      panes.push(pane(id, `term_${next}`, params.root.label));
      await Bun.sleep(5); // report_metadata lands later, as it does for real
      return ok({ layout: { root: { pane_id: id } } });
    }
    if (method === "pane.report_metadata") { panes.find((p) => p.pane_id === params.pane_id).tokens = params.tokens; return ok({ type: "ok" }); }
    if (method === "pane.close") { panes.splice(panes.findIndex((p) => p.pane_id === params.pane_id), 1); return ok({ type: "ok" }); }
    return ok({ type: "pong" });
  });
  const [a, b] = await Promise.all([f.herdr.spawn("cs-a", "exec claude"), f.herdr.spawn("cs-b", "exec codex")]);
  expect([a.code, b.code]).toEqual([0, 0]);
  expect(f.requests.filter((r) => r.method === "pane.close")).toHaveLength(0);
  expect(parseHerdrPanes({ panes }).live.map((p) => p.name).sort()).toEqual(["cs-a", "cs-b"]);
});

test("list: each live pane's holder pid is its own root process, not the shared server", async () => {
  const pids: Record<string, number> = { "w1:p2": 201, "w1:p4": 202 };
  const f = fakeHerdr((method, params) => {
    if (method === "pane.list") return ok({ panes: [pane("w1:p2", "term_aa", "cs-a", "cs-a"), pane("w1:p3", "term_bb", "cs-x"), pane("w1:p4", "term_cc", "cs-b", "cs-b")] });
    if (method === "pane.process_info") return pids[params.pane_id] ? ok({ process_info: { pane_id: params.pane_id, shell_pid: pids[params.pane_id] } }) : err("not_found");
    return ok({});
  });
  expect(await f.herdr.list()).toEqual([
    { name: "cs-a", paneId: "w1:p2", terminalId: "term_aa", pid: 201, backend: "herdr" },
    { name: "cs-b", paneId: "w1:p4", terminalId: "term_cc", pid: 202, backend: "herdr" },
  ]);
});

test("list: a down server lists nothing; one that stops answering keeps the last listing, or throws before any", async () => {
  let reply: HerdrReply = err("timeout");
  const f = fakeHerdr((method) => (method === "pane.list" ? reply : ok({ process_info: { shell_pid: 9 } })));
  // Cold start (app just restarted): no listing yet, so "no answer" must not read as "no sessions".
  await expect(f.herdr.list()).rejects.toThrow();
  reply = ok({ panes: [pane("w1:p2", "term_aa", "cs-a", "cs-a")] });
  const good = await f.herdr.list();
  expect(good).toHaveLength(1);
  reply = err("timeout");
  expect(await f.herdr.list()).toEqual(good);
  reply = err("malformed");
  expect(await f.herdr.list()).toEqual(good);
  reply = err("server_not_running");
  expect(await f.herdr.list()).toEqual([]);
});

test("quit closes every pane under the name, live or leftover", async () => {
  const f = fakeHerdr((method) => method === "pane.list"
    ? ok({ panes: [pane("w1:p2", "term_aa", "cs-a", "cs-a"), pane("w1:p3", "term_bb", "cs-a"), pane("w1:p4", "term_cc", "cs-b", "cs-b")] })
    : ok({ type: "ok" }));
  await f.herdr.quit("cs-a");
  expect(f.requests.filter((r) => r.method === "pane.close").map((r) => r.params.pane_id).sort()).toEqual(["w1:p2", "w1:p3"]);
});

test("read and write go to the pane; input bytes pass through unchanged", async () => {
  const f = fakeHerdr((method) => method === "pane.read" ? ok({ read: { text: "hello\n" } }) : ok({ type: "ok" }));
  expect(await f.herdr.read("w1:p2", "recent", 40)).toEqual({ ok: true, text: "hello\n" });
  expect(f.requests[0]).toEqual({ method: "pane.read", params: { pane_id: "w1:p2", source: "recent", lines: 40 } });
  const bytes = "\x1b[200~hi\\x\x1b[201~";
  expect(await f.herdr.write("w1:p2", bytes)).toEqual({ ok: true });
  expect(f.requests[1]).toEqual({ method: "pane.send_text", params: { pane_id: "w1:p2", text: bytes } });
});
