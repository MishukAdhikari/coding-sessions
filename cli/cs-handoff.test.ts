import { afterEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDir, findClaudeTranscript, fmtBytes, handoffReceiveCommand, parseHandoffArgs, parseServerArgs, symlinkedTranscripts } from "./cs-lib";
import { adoptHandoffTranscript, mungeCwd } from "../server/handoff";

const dirs: string[] = [];
const temp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "cs-cli-handoff-"))); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const ID = "5d1e2f30-aaaa-4bbb-8ccc-ddddeeeeffff";

test("cs handoff parses an optional name, an instruction and its flags", () => {
  expect(parseServerArgs(["handoff", "x"]).sub).toBe("handoff");
  expect(parseServerArgs(["-S", "lab", "handoff"])).toMatchObject({ sub: "handoff", server: "lab" });
  expect(parseHandoffArgs([])).toMatchObject({ name: null, instruction: null, compactHint: false, agent: "claude" });
  expect(parseHandoffArgs(["login-fix"])).toMatchObject({ name: "login-fix", instruction: null });
  expect(parseHandoffArgs(["login-fix", "now add tests"])).toMatchObject({ name: "login-fix", instruction: "now add tests" });
  expect(parseHandoffArgs(["now add tests"])).toMatchObject({ name: null, instruction: "now add tests" });
  expect(parseHandoffArgs(["--name", "n1", "go", "on"])).toMatchObject({ name: "n1", instruction: "go on" });
  expect(parseHandoffArgs(["--compact-hint", "--agent", "codex"])).toMatchObject({ compactHint: true, agent: "codex" });
  expect(parseHandoffArgs(["--agent=claude"]).agent).toBe("claude");
  expect(parseHandoffArgs(["--agent", "gpt"]).error).toContain("claude or codex");
  expect(parseHandoffArgs(["--bogus"]).error).toContain("unknown option");
  expect(parseHandoffArgs(["--name", "bad name"]).error).toContain("name");
});

test("findClaudeTranscript picks the newest regular transcript for the folder, skipping symlinks and other files", () => {
  const home = temp();
  const cwd = "/Users/me/my.app";
  const dir = claudeProjectDir(home, cwd);
  expect(dir).toBe(`${home}/.claude/projects/-Users-me-my-app`);
  expect(findClaudeTranscript(home, cwd)).toBeNull();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "old.jsonl"), "{}\n");
  utimesSync(join(dir, "old.jsonl"), 1000, 1000);
  writeFileSync(join(dir, `${ID}.jsonl`), "{}\n{}\n");
  utimesSync(join(dir, `${ID}.jsonl`), 2000, 2000);
  writeFileSync(join(dir, "empty.jsonl"), "");
  writeFileSync(join(dir, "notes.txt"), "x");
  writeFileSync(join(home, "outside.jsonl"), "{}");
  symlinkSync(join(home, "outside.jsonl"), join(dir, "link.jsonl"));
  utimesSync(join(home, "outside.jsonl"), 9000, 9000);
  expect(findClaudeTranscript(home, cwd)).toMatchObject({ id: ID, bytes: 6, path: join(dir, `${ID}.jsonl`) });
  // The skipped link is still named, so cs handoff can say why it was not used.
  expect(symlinkedTranscripts(home, cwd).map((l) => l.name)).toEqual(["link.jsonl"]);
  expect(symlinkedTranscripts(home, "/nowhere")).toEqual([]);
});

test("fmtBytes shows a readable size", () => {
  expect(fmtBytes(512)).toBe("512 B");
  expect(fmtBytes(2048)).toBe("2.0 KB");
  expect(fmtBytes(3 * 1024 * 1024)).toBe("3.0 MB");
});

test("the SSH receive command writes the transcript 0600 into a fresh 0700 staging folder, and refuses unsafe ids", async () => {
  const ws = join(temp(), "work space");
  mkdirSync(ws);
  mkdirSync(join(ws, ".cs-handoff"));
  writeFileSync(join(ws, ".cs-handoff", "stale.jsonl"), "old");
  const p = Bun.spawn(["sh", "-c", handoffReceiveCommand(ws, ID)], { stdin: new TextEncoder().encode("line1\nline2\n") });
  expect(await p.exited).toBe(0);
  const file = join(ws, ".cs-handoff", `${ID}.jsonl`);
  expect(readFileSync(file, "utf8")).toBe("line1\nline2\n");
  expect(lstatSync(file).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(ws, ".cs-handoff")).mode & 0o777).toBe(0o700);
  expect(() => lstatSync(join(ws, ".cs-handoff", "stale.jsonl"))).toThrow();
  expect(() => handoffReceiveCommand(ws, "a;rm -rf /")).toThrow();
});

/**
 * The real `cs handoff` against a stub server: fake `ssh` and `rsync` on PATH run the
 * remote side locally, and the stub's launch adopts the transcript as the server does.
 */
test("cs handoff end to end with a stubbed server: rsync, SSH upload, adopt and launch with resumeId", async () => {
  const root = temp();
  const home = join(root, "home");
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const ws = join(root, "workspaces", "k-handoff-test");
  const serverProjects = join(root, "server-projects");
  for (const d of [home, bin, repo, ws]) mkdirSync(d, { recursive: true });

  writeFileSync(join(bin, "ssh"), `#!/bin/sh\n# fake ssh: drop options and the host, run the remote command here\nwhile [ "$1" = "-o" ]; do shift 2; done\nshift\nexec sh -c "$*"\n`);
  writeFileSync(join(bin, "rsync"), `#!/bin/sh\necho "$@" >> "${join(root, "rsync.log")}"\n`);
  chmodSync(join(bin, "ssh"), 0o755); chmodSync(join(bin, "rsync"), 0o755);

  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, HOME: home } });
  git("init", "-q", "-b", "handoff-test");
  git("remote", "add", "origin", "git@github.com:me/app.git");
  writeFileSync(join(repo, "wip.txt"), "uncommitted");

  const tdir = claudeProjectDir(home, repo);
  mkdirSync(tdir, { recursive: true });
  const lines = [{ type: "user", sessionId: ID, cwd: repo, message: { content: "fix it" } }, { type: "assistant", sessionId: ID, cwd: repo, message: { content: "done" } }];
  writeFileSync(join(tdir, `${ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const calls: Array<{ path: string; body: any }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? (await req.json() as { resumeId?: string }) : null;
      calls.push({ path: url.pathname, body });
      if (req.headers.get("authorization") !== "Bearer cs_test") return Response.json({ error: "no" }, { status: 401 });
      if (url.pathname === "/api/synced/status") return Response.json({ state: "none", name: "k-handoff-test", workspacePath: ws, claudeUrl: null, resumeId: null });
      if (url.pathname === "/api/synced/prepare") return Response.json({ ok: true, workspacePath: ws });
      if (url.pathname === "/api/synced/launch") {
        const r = adoptHandoffTranscript({ workspace: ws, resumeId: String(body?.resumeId), projectsDir: serverProjects });
        return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: 422 });
      }
      if (url.pathname === "/api/sessions") return Response.json({ sessions: [{ name: "k-handoff-test", claudeUrl: "https://claude.ai/code/session_x" }] });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  try {
    const cs = join(import.meta.dir, "cs.ts");
    const p = Bun.spawn([process.execPath, cs, "handoff", "--compact-hint", "now add tests"], {
      cwd: repo,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(root, "cfg"), PATH: `${bin}:${process.env.PATH}`,
        CS_API: `http://127.0.0.1:${server.port}`, CS_TOKEN: "cs_test", CS_SSH: "fake-host", NO_COLOR: "1", CS_SERVER: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain(`Conversation ${ID}`);
    expect(out).toContain("/compact");
    expect(out).toContain("Uploading the conversation");
    expect(out).toContain("https://claude.ai/code/session_x");
    expect(out).toContain("You can stop the local agent");

    expect(calls.map((c) => c.path)).toEqual(["/api/synced/status", "/api/synced/prepare", "/api/synced/launch", "/api/sessions"]);
    expect(calls[1]!.body).toEqual({ name: "handoff-test", repo: "me/app", branch: "handoff-test" });
    expect(calls[2]!.body).toEqual({ name: "handoff-test", prompt: "now add tests", resumeId: ID, handoff: true });
    // The tree went up with rsync to the prepared workspace, as a Synced Launch does.
    expect(readFileSync(join(root, "rsync.log"), "utf8")).toContain(`fake-host:${ws}/`);
    // The transcript never travelled in an HTTPS body.
    expect(JSON.stringify(calls)).not.toContain("fix it");
    // And it landed where `claude --resume` on the server finds it, cwd rewritten.
    const adopted = readFileSync(join(serverProjects, mungeCwd(ws), `${ID}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(adopted.map((l) => l.cwd)).toEqual([ws, ws]);
    expect(adopted[0].message.content).toBe("fix it");
  } finally {
    server.stop(true);
  }
});

test("cs handoff refuses Codex for now, a folder without a conversation, and a name already on the server", async () => {
  const root = temp();
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home); mkdirSync(repo);
  Bun.spawnSync(["git", "init", "-q", "-b", "b1"], { cwd: repo });
  Bun.spawnSync(["git", "remote", "add", "origin", "https://github.com/me/app.git"], { cwd: repo });
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ state: "live", name: "k-b1", workspacePath: "/x" }) });
  const run = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "cs.ts"), "handoff", ...args], {
      cwd: repo, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(root, "cfg"), CS_API: `http://127.0.0.1:${server.port}`, CS_TOKEN: "t", CS_SSH: "h", CS_SERVER: "" },
    });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    return { err, code };
  };
  try {
    expect(await run("--agent", "codex")).toMatchObject({ code: 1, err: expect.stringContaining("Codex handoff isn't supported yet") });
    expect(await run()).toMatchObject({ code: 1, err: expect.stringContaining("no Claude Code conversation") });
    const dir = claudeProjectDir(home, repo);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ID}.jsonl`), "{}\n");
    expect(await run()).toMatchObject({ code: 1, err: expect.stringContaining("already runs on the server") });
  } finally {
    server.stop(true);
  }
});
