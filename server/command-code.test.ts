import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyDatabaseSchema } from "./db-schema";
import {
  buildCommandCodeInvocation,
  clearCommandCodeToken,
  commandCodeEnv,
  commandCodeModel,
  commandCodeProjectDirName,
  findCommandCodeSessionId,
  findCommandCodeTranscript,
  hasCommandCodeToken,
  isCommandCodeProc,
  isCommandCodeSessionId,
  normalizeCommandCodeSessionId,
  parseCommandCodeVersion,
  preflightCommandCode,
  setCommandCodeToken,
  type CommandCodeFsDependencies,
  type CommandResult,
} from "./command-code";
import { capabilitiesFor, parseSessionProvider } from "./session-provider";
import { canResumeCommandCodeArchive, providerDisplayName } from "./sessions";

const freshDb = () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  return database;
};

const SESSION = "893bcbb9-3e76-4eae-88f0-64201a0f641e";

/* ---------- provider identity ---------- */

test("command-code parses as a built-in, never as a registered Command", () => {
  expect(parseSessionProvider("command-code")).toBe("command-code");
  expect(parseSessionProvider("cmd:command-code")).toBe("cmd:command-code");
  expect(capabilitiesFor("command-code").displayName).toBe("Command Code");
  expect(providerDisplayName("command-code")).toBe("Command Code");
});

test("it claims exact resume and declines turn state, because that is what its CLI gives", () => {
  const capabilities = capabilitiesFor("command-code");
  expect(capabilities.exactResume).toBe(true);
  expect(capabilities.semanticStatus).toBe(false);
  expect(capabilities.remoteControl).toBe(false);
  expect(capabilities.chatDeletion).toBe(false);
});

/* ---------- conversation ids ---------- */

test("only a UUID is accepted as a conversation id", () => {
  expect(normalizeCommandCodeSessionId(SESSION.toUpperCase())).toBe(SESSION);
  expect(isCommandCodeSessionId(SESSION)).toBe(true);
  for (const bad of ["", "latest", `${SESSION} extra`, "../../etc/passwd", `'; rm -rf /`, null, 7]) {
    expect(normalizeCommandCodeSessionId(bad)).toBeNull();
  }
});

/* ---------- launch argv ---------- */

test("standard launches retain CLI trust and approval prompts", () => {
  expect(buildCommandCodeInvocation({ bin: "/usr/bin/command-code", cwd: "/home/example/ws/demo", name: "demo" }))
    .toEqual(["/usr/bin/command-code", "--no-auto-update", "-n", "demo"]);
});

test("unrestricted launches explicitly opt into trust and approval bypass", () => {
  expect(buildCommandCodeInvocation({ bin: "/usr/bin/command-code", cwd: "/ws", name: "demo", unrestricted: true }))
    .toEqual(["/usr/bin/command-code", "--trust", "--yolo", "--no-auto-update", "-n", "demo"]);
});

test("an absolute path with spaces still launches — npm installs it into one", () => {
  const bin = "/Users/example/Library/Application Support/Herd/node/bin/command-code";
  expect(buildCommandCodeInvocation({ bin, cwd: "/home/example/ws/demo", name: "demo" })?.[0]).toBe(bin);
});

test("a resume appends the exact conversation, lower-cased", () => {
  expect(buildCommandCodeInvocation({
    bin: "/usr/bin/command-code",
    cwd: "/home/example/ws/demo",
    name: "demo",
    resumeId: SESSION.toUpperCase(),
  })).toEqual([
    "/usr/bin/command-code", "--no-auto-update", "-n", "demo", "--session", SESSION,
  ]);
});

test("a launch that cannot be built safely is refused rather than quoted around", () => {
  const base = { bin: "/usr/bin/command-code", cwd: "/home/example/ws/demo", name: "demo" };
  expect(buildCommandCodeInvocation({ ...base, cwd: "relative/path" })).toBeNull();
  expect(buildCommandCodeInvocation({ ...base, name: "demo; rm -rf /" })).toBeNull();
  expect(buildCommandCodeInvocation({ ...base, name: "" })).toBeNull();
  expect(buildCommandCodeInvocation({ ...base, bin: "command code" })).toBeNull();
  expect(buildCommandCodeInvocation({ ...base, bin: "relative/command-code" })).toBeNull();
  expect(buildCommandCodeInvocation({ ...base, resumeId: "latest" })).toBeNull();
  expect(buildCommandCodeInvocation({ ...base, resumeId: `${SESSION}; reboot` })).toBeNull();
});

/* ---------- process recognition ---------- */

test("the agent is recognised by the process title it rewrites itself to", () => {
  expect(isCommandCodeProc("⌘ Command Code · xcloud-sessions    ")).toBe(true);
  expect(isCommandCodeProc("Command Code")).toBe(true);
});

test("it is also recognised during startup, before the title lands", () => {
  expect(isCommandCodeProc("node /usr/bin/command-code --trust --yolo -n demo")).toBe(true);
  expect(isCommandCodeProc("/usr/local/bin/commandcode --yolo")).toBe(true);
  expect(isCommandCodeProc("bun /usr/lib/node_modules/command-code/dist/cmdc --yolo")).toBe(true);
});

test("other agents and the screen wrappers around them are not adopted", () => {
  expect(isCommandCodeProc("codex --dangerously-bypass-approvals-and-sandbox")).toBe(false);
  expect(isCommandCodeProc("claude --remote-control demo")).toBe(false);
  expect(isCommandCodeProc("bash -lc cd /ws && exec command-code --yolo")).toBe(false);
  expect(isCommandCodeProc("SCREEN -dmS cs-demo bash -lc exec command-code")).toBe(false);
  expect(isCommandCodeProc("node /usr/bin/some-other-agent")).toBe(false);
  expect(isCommandCodeProc("")).toBe(false);
});

/* ---------- project directory naming ---------- */

test("the project directory name matches what the agent actually writes", () => {
  expect(commandCodeProjectDirName("/Users/example/Code/xCloud")).toBe("users-example-code-x-cloud");
  expect(commandCodeProjectDirName("/home/example/workspaces/fix-login")).toBe("home-example-workspaces-fix-login");
  expect(commandCodeProjectDirName("/var/www/xcloud-sessions")).toBe("var-www-xcloud-sessions");
});

/* ---------- conversation discovery ---------- */

const fakeFs = (tree: Record<string, Record<string, { text?: string; mtime: number }>>): CommandCodeFsDependencies => ({
  listDirs: (dir) => (dir.endsWith("/projects") ? Object.keys(tree) : []),
  listFiles: (dir) => Object.keys(tree[dir.slice(dir.lastIndexOf("/") + 1)] ?? {}),
  readText: (path) => {
    const file = path.slice(path.lastIndexOf("/") + 1);
    const dir = path.slice(0, path.lastIndexOf("/"));
    return tree[dir.slice(dir.lastIndexOf("/") + 1)]?.[file]?.text ?? null;
  },
  mtimeMs: (path) => {
    const file = path.slice(path.lastIndexOf("/") + 1);
    const dir = path.slice(0, path.lastIndexOf("/"));
    return tree[dir.slice(dir.lastIndexOf("/") + 1)]?.[file]?.mtime ?? null;
  },
});

const meta = (title: string) => JSON.stringify({ title, userRenamed: true });

test("a launch finds the conversation the agent opened for it", () => {
  const fs = fakeFs({
    "home-example-workspaces-demo": {
      [`${SESSION}.meta.json`]: { text: meta("demo"), mtime: 1_000 },
    },
  });
  expect(findCommandCodeSessionId("/home/example/workspaces/demo", "demo", 1_000, fs)).toBe(SESSION);
});

test("a conversation older than the launch is never adopted as this launch's own", () => {
  const fs = fakeFs({
    "home-example-workspaces-demo": {
      [`${SESSION}.meta.json`]: { text: meta("demo"), mtime: 500 },
    },
  });
  // Relaunching a reused name must not resume the previous conversation by accident.
  expect(findCommandCodeSessionId("/home/example/workspaces/demo", "demo", 60_000, fs)).toBeNull();
});

test("another session's conversation in the same folder is left alone", () => {
  const older = "11111111-1111-4111-8111-111111111111";
  const fs = fakeFs({
    "home-example-workspaces-demo": {
      [`${older}.meta.json`]: { text: meta("other"), mtime: 2_000 },
      [`${SESSION}.meta.json`]: { text: meta("demo"), mtime: 1_500 },
    },
  });
  expect(findCommandCodeSessionId("/home/example/workspaces/demo", "demo", 1_000, fs)).toBe(SESSION);
});

test("when the folder naming does not match, every project directory is still searched", () => {
  const fs = fakeFs({
    "some-other-scheme": {
      [`${SESSION}.meta.json`]: { text: meta("demo"), mtime: 1_000 },
    },
  });
  expect(findCommandCodeSessionId("/home/example/workspaces/demo", "demo", 1_000, fs)).toBe(SESSION);
});

test("unreadable or malformed meta files never crash discovery", () => {
  const fs = fakeFs({
    "home-example-workspaces-demo": {
      "not-a-uuid.meta.json": { text: meta("demo"), mtime: 1_000 },
      [`${SESSION}.meta.json`]: { text: "{ truncated", mtime: 1_000 },
    },
  });
  expect(findCommandCodeSessionId("/home/example/workspaces/demo", "demo", 1_000, fs)).toBeNull();
});

test("a transcript is found only where one exists", () => {
  const fs = fakeFs({
    "home-example-workspaces-demo": {
      [`${SESSION}.jsonl`]: { text: "", mtime: 1_000 },
      [`${SESSION}.meta.json`]: { text: meta("demo"), mtime: 1_000 },
    },
  });
  expect(findCommandCodeTranscript("/home/example/workspaces/demo", SESSION, fs))
    .toBe(`${process.env.HOME}/.commandcode/projects/home-example-workspaces-demo/${SESSION}.jsonl`);
  expect(findCommandCodeTranscript("/home/example/workspaces/demo", "11111111-1111-4111-8111-111111111111", fs))
    .toBeNull();
  expect(findCommandCodeTranscript("/home/example/workspaces/demo", "latest", fs)).toBeNull();
});

test("an archive with no conversation on disk declines to offer resume", () => {
  // The folder is gone, so nothing here can be reopened whatever the id says.
  expect(canResumeCommandCodeArchive("/nope/gone", "demo", SESSION)).toBe(false);
  expect(canResumeCommandCodeArchive(null, "demo", SESSION)).toBe(false);
  expect(canResumeCommandCodeArchive("/tmp", "demo", null)).toBe(false);
  expect(canResumeCommandCodeArchive("/tmp", "demo", "latest")).toBe(false);
});

/* ---------- model ---------- */

test("the model is the last one the transcript recorded, minus its routing prefix", () => {
  expect(commandCodeModel('{"model":"deepseek/deepseek-v4-pro"}\n{"model":"qwen/qwen3-max"}')).toBe("qwen3-max");
  expect(commandCodeModel('{"model": "glm-5"}')).toBe("glm-5");
  expect(commandCodeModel("nothing here")).toBeNull();
});

/* ---------- credential ---------- */

test("a stored key is reported, never returned, and reaches the agent as an env var", () => {
  const database = freshDb();
  expect(hasCommandCodeToken(database)).toBe(false);
  expect(commandCodeEnv(database)).toEqual({});

  expect(setCommandCodeToken("  cc-live-secret  ", database)).toEqual({ ok: true });
  expect(hasCommandCodeToken(database)).toBe(true);
  expect(commandCodeEnv(database)).toEqual({ COMMAND_CODE_API_KEY: "cc-live-secret" });

  expect(clearCommandCodeToken(database)).toBe(true);
  expect(hasCommandCodeToken(database)).toBe(false);
  expect(commandCodeEnv(database)).toEqual({});
});

test("an unusable key is refused at the door", () => {
  const database = freshDb();
  expect(setCommandCodeToken("   ", database).ok).toBe(false);
  expect(setCommandCodeToken("bad\nkey", database).ok).toBe(false);
  expect(setCommandCodeToken("x".repeat(5000), database).ok).toBe(false);
  expect(hasCommandCodeToken(database)).toBe(false);
});

/* ---------- preflight ---------- */

const result = (over: Partial<CommandResult> = {}): CommandResult => ({ code: 0, out: "", err: "", ...over });

function preflightDeps(over: {
  bin?: string | null;
  version?: CommandResult;
  status?: CommandResult;
  env?: Record<string, string>;
  seen?: Array<{ argv: string[]; env?: Record<string, string> }>;
}) {
  return {
    which: () => (over.bin === undefined ? "/usr/bin/command-code" : over.bin),
    run: async (argv: string[], _timeout: number, env?: Record<string, string>) => {
      over.seen?.push({ argv, env });
      return argv.includes("--version") ? (over.version ?? result({ out: "1.32.1" })) : (over.status ?? result());
    },
    env: () => over.env ?? {},
  };
}

test("preflight passes on an installed, current, authenticated CLI", async () => {
  expect(await preflightCommandCode(preflightDeps({}))).toEqual({
    ok: true,
    bin: "/usr/bin/command-code",
    version: "1.32.1",
  });
});

test("preflight names the specific reason a launch would have died in the screen", async () => {
  expect(await preflightCommandCode(preflightDeps({ bin: null }))).toMatchObject({ ok: false, code: "missing_binary" });
  expect(await preflightCommandCode(preflightDeps({ version: result({ out: "1.2.0" }) })))
    .toMatchObject({ ok: false, code: "unsupported_version" });
  expect(await preflightCommandCode(preflightDeps({ version: result({ code: 1, err: "boom" }) })))
    .toMatchObject({ ok: false, code: "unsupported_version" });
  expect(await preflightCommandCode(preflightDeps({ status: result({ code: 1 }) })))
    .toMatchObject({ ok: false, code: "not_authenticated" });
  expect(await preflightCommandCode(preflightDeps({ status: result({ code: 124, timedOut: true }) })))
    .toMatchObject({ ok: false, code: "command_timeout" });
});

test("preflight probes never trigger the CLI's background self-update", async () => {
  const seen: Array<{ argv: string[]; env?: Record<string, string> }> = [];
  await preflightCommandCode(preflightDeps({ seen }));
  expect(seen).toHaveLength(2);
  for (const call of seen) expect(call.argv).toContain("--no-auto-update");
});

test("the auth check runs under the same key the session will get", async () => {
  const seen: Array<{ argv: string[]; env?: Record<string, string> }> = [];
  await preflightCommandCode(preflightDeps({ env: { COMMAND_CODE_API_KEY: "cc-live-secret" }, seen }));
  const status = seen.find((call) => call.argv.includes("status"));
  // A key that is merely stored proves nothing; this asks the CLI what it makes of it.
  expect(status?.env).toEqual({ COMMAND_CODE_API_KEY: "cc-live-secret" });
});

test("version parsing survives the shapes a CLI actually prints", () => {
  expect(parseCommandCodeVersion("1.32.1")).toEqual([1, 32, 1]);
  expect(parseCommandCodeVersion("Command Code v1.28.4\n")).toEqual([1, 28, 4]);
  expect(parseCommandCodeVersion("no version here")).toBeNull();
});
