import { expect, test } from "bun:test";
import {
  buildCodexInvocation,
  CODEX_MANAGED_BUN_PATH,
  CODEX_MANAGED_HOOK_COMMAND,
  CODEX_MANAGED_HOOK_PATH,
  CODEX_MANAGED_STATE_PATH,
  CODEX_PREFLIGHT_COMMAND_TIMEOUT_MS,
  CODEX_REQUIREMENTS_PATH,
  defaultCodexPreflightDependencies,
  parseCodexVersion,
  preflightCodex,
  type CodexManagedPathInspection,
  type CodexPreflightDependencies,
} from "./codex";

const launchId = "019fb1b3-f208-73f2-ba13-0665f58ae4a0";
const resumeId = "019fb1c0-aaaa-7bbb-8ccc-0123456789ab";

const managedEvents = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "SessionEnd",
];

function managedRequirements(): string {
  const matchers: Record<string, string> = {
    SessionStart: "^(startup|resume|clear|compact)$",
    PreToolUse: "^(request_user_input|AskUserQuestion)$",
    PostToolUse: "^(request_user_input|AskUserQuestion)$",
  };
  return [
    "[features]",
    "hooks = true",
    "[hooks]",
    "managed_dir = '/usr/local/lib/xcloud-sessions/codex-hooks'",
    ...managedEvents.flatMap((event) => [
      `[[hooks.${event}]]`,
      ...(matchers[event] ? [`matcher = '${matchers[event]}'`] : []),
      `[[hooks.${event}.hooks]]`,
      "type = 'command'",
      `command = '${CODEX_MANAGED_HOOK_COMMAND}'`,
      `timeout = ${event === "SessionEnd" ? 3 : 5}`,
    ]),
  ].join("\n");
}

const managedFiles = new Set([
  CODEX_REQUIREMENTS_PATH,
  CODEX_MANAGED_BUN_PATH,
  CODEX_MANAGED_HOOK_PATH,
  CODEX_MANAGED_STATE_PATH,
]);

function securePathInspection(path: string): CodexManagedPathInspection {
  const kind = managedFiles.has(path) ? "file" : "directory";
  return {
    uid: 0,
    mode: kind === "directory" || path === CODEX_MANAGED_BUN_PATH ? 0o755 : 0o644,
    kind,
    executable: path === CODEX_MANAGED_BUN_PATH,
  };
}

function preflightDependencies(requirements = managedRequirements()): CodexPreflightDependencies {
  const files = new Map([
    [CODEX_REQUIREMENTS_PATH, requirements],
    [CODEX_MANAGED_HOOK_PATH, "// installed"],
    [CODEX_MANAGED_STATE_PATH, "// installed"],
  ]);
  return {
    which: () => "/usr/local/bin/codex",
    run: async (argv) => {
      if (argv.includes("--version")) return { code: 0, out: "codex-cli 0.146.0", err: "" };
      if (argv.includes("status")) return { code: 0, out: "Logged in", err: "" };
      return { code: 0, out: "hooks stable true", err: "" };
    },
    readText: (path) => files.get(path) ?? null,
    inspectPath: securePathInspection,
  };
}

test("builds stable new and exact-resume invocations with bounded app markers", () => {
  expect(buildCodexInvocation({
    bin: "/usr/local/bin/codex",
    cwd: "/srv/project",
    screen: "cs-demo",
    launchId,
    dbPath: "/srv/app/data/app.db",
  })).toEqual({
    argv: [
      "/usr/local/bin/codex",
      "-C",
      "/srv/project",
    ],
    env: {
      CS_DB_PATH: "/srv/app/data/app.db",
      CS_LAUNCH_ID: launchId,
      CS_SCREEN: "cs-demo",
    },
  });

  expect(buildCodexInvocation({
    bin: "/usr/local/bin/codex",
    cwd: "/srv/project",
    screen: "cs-demo",
    launchId,
    dbPath: "/srv/app/data/app.db",
    resumeId,
  })?.argv).toEqual([
    "/usr/local/bin/codex",
    "-C",
    "/srv/project",
    "resume",
    resumeId,
  ]);
});

test("rejects command and marker injection instead of quoting arbitrary values", () => {
  expect(buildCodexInvocation({ bin: "codex", cwd: "relative", screen: "cs-demo", launchId, dbPath: "/tmp/app.db" })).toBeNull();
  expect(buildCodexInvocation({ bin: "codex", cwd: "/tmp", screen: "cs-demo;touch-x", launchId, dbPath: "/tmp/app.db" })).toBeNull();
  expect(buildCodexInvocation({ bin: "codex", cwd: "/tmp", screen: "cs-demo", launchId: "bad", dbPath: "/tmp/app.db" })).toBeNull();
  expect(buildCodexInvocation({ bin: "codex", cwd: "/tmp", screen: "cs-demo", launchId, dbPath: "/tmp/app.db", resumeId: "--last" })).toBeNull();
});

test("parses the tested Codex version floor", () => {
  expect(parseCodexVersion("codex-cli 0.146.0")).toEqual([0, 146, 0]);
  expect(parseCodexVersion("codex-cli 1.2.3-beta.1")).toEqual([1, 2, 3]);
  expect(parseCodexVersion("unknown")).toBeNull();
});

test("preflight distinguishes binary, version, login, hooks, and managed provisioning", async () => {
  const requirements = managedRequirements();
  const files = new Map([
    [CODEX_REQUIREMENTS_PATH, requirements],
    [CODEX_MANAGED_HOOK_PATH, "// installed"],
    [CODEX_MANAGED_STATE_PATH, "// installed"],
  ]);
  const deps: CodexPreflightDependencies = {
    ...preflightDependencies(requirements),
    readText: (path: string) => files.get(path) ?? null,
  };
  expect(await preflightCodex(deps)).toMatchObject({ ok: true, bin: "/usr/local/bin/codex", version: "0.146.0" });
  expect(await preflightCodex({ ...deps, which: () => null })).toMatchObject({ ok: false, code: "missing_binary" });
  expect(await preflightCodex({ ...deps, run: async (argv, timeoutMs) => argv.includes("--version")
    ? { code: 0, out: "codex-cli 0.145.0", err: "" }
    : deps.run(argv, timeoutMs) })).toMatchObject({ ok: false, code: "unsupported_version" });
  expect(await preflightCodex({ ...deps, run: async (argv, timeoutMs) => argv.includes("status")
    ? { code: 1, out: "", err: "not logged in" }
    : deps.run(argv, timeoutMs) })).toMatchObject({ ok: false, code: "not_authenticated" });
  expect(await preflightCodex({ ...deps, run: async (argv, timeoutMs) => argv.includes("features")
    ? { code: 0, out: "hooks stable false", err: "" }
    : deps.run(argv, timeoutMs) })).toMatchObject({ ok: false, code: "hooks_unavailable" });
  expect(await preflightCodex({ ...deps, readText: () => null })).toMatchObject({ ok: false, code: "managed_hook_missing" });
  expect(await preflightCodex({
    ...deps,
    readText: (path) => path.endsWith("codex-state.ts") ? null : files.get(path) ?? null,
  })).toMatchObject({ ok: false, code: "managed_hook_missing" });
  expect(await preflightCodex({
    ...deps,
    readText: (path) => path === CODEX_REQUIREMENTS_PATH
      ? requirements.replace("[[hooks.Stop.hooks]]", "[[hooks.Missing.hooks]]")
      : files.get(path) ?? null,
  })).toMatchObject({ ok: false, code: "managed_hook_untrusted" });
});

test("preflight requires the exact root-managed command for every hook", async () => {
  const requirements = managedRequirements();
  const withExtraCommand = requirements.replace(
    `command = '${CODEX_MANAGED_HOOK_COMMAND}'`,
    [
      `command = '${CODEX_MANAGED_HOOK_COMMAND}'`,
      "[[hooks.SessionStart.hooks]]",
      "type = 'command'",
      `command = '/home/example/.bun/bin/bun ${CODEX_MANAGED_HOOK_PATH}'`,
    ].join("\n"),
  );
  expect(await preflightCodex(preflightDependencies(withExtraCommand))).toMatchObject({
    ok: false,
    code: "managed_hook_untrusted",
  });

  const alteredExactCommand = requirements.replace(
    CODEX_MANAGED_HOOK_COMMAND,
    `${CODEX_MANAGED_BUN_PATH}  ${CODEX_MANAGED_HOOK_PATH}`,
  );
  expect(await preflightCodex(preflightDependencies(alteredExactCommand))).toMatchObject({
    ok: false,
    code: "managed_hook_untrusted",
  });

  const widenedMatcher = requirements.replace(
    "matcher = '^(request_user_input|AskUserQuestion)$'",
    "matcher = '.*'",
  );
  expect(await preflightCodex(preflightDependencies(widenedMatcher))).toMatchObject({
    ok: false,
    code: "managed_hook_untrusted",
  });

  const extendedTimeout = requirements.replace("timeout = 5", "timeout = 60");
  expect(await preflightCodex(preflightDependencies(extendedTimeout))).toMatchObject({
    ok: false,
    code: "managed_hook_untrusted",
  });
});

test("preflight rejects missing, writable, linked, non-root, and non-executable managed paths", async () => {
  const cases: Array<{
    path: string;
    inspection: CodexManagedPathInspection | null;
    code: "managed_hook_missing" | "managed_hook_untrusted";
  }> = [
    { path: CODEX_REQUIREMENTS_PATH, inspection: null, code: "managed_hook_missing" },
    {
      path: "/usr/local/lib/xcloud-sessions/bin",
      inspection: { ...securePathInspection("/usr/local/lib/xcloud-sessions/bin"), kind: "symlink" },
      code: "managed_hook_untrusted",
    },
    {
      path: CODEX_MANAGED_HOOK_PATH,
      inspection: { ...securePathInspection(CODEX_MANAGED_HOOK_PATH), uid: 1000 },
      code: "managed_hook_untrusted",
    },
    {
      path: CODEX_MANAGED_STATE_PATH,
      inspection: { ...securePathInspection(CODEX_MANAGED_STATE_PATH), mode: 0o664 },
      code: "managed_hook_untrusted",
    },
    {
      path: CODEX_MANAGED_BUN_PATH,
      inspection: { ...securePathInspection(CODEX_MANAGED_BUN_PATH), executable: false },
      code: "managed_hook_untrusted",
    },
  ];

  for (const scenario of cases) {
    const deps = preflightDependencies();
    const result = await preflightCodex({
      ...deps,
      inspectPath: (path) => path === scenario.path ? scenario.inspection : securePathInspection(path),
    });
    expect(result).toMatchObject({ ok: false, code: scenario.code });
    expect(result.ok ? "" : result.message).toContain(scenario.path);
  }
});

test("preflight applies command deadlines and returns an actionable timeout", async () => {
  const observedTimeouts: number[] = [];
  const deps = preflightDependencies();
  const result = await preflightCodex({
    ...deps,
    run: async (argv, timeoutMs) => {
      observedTimeouts.push(timeoutMs);
      if (argv.includes("status")) return { code: 124, out: "", err: "", timedOut: true };
      return deps.run(argv, timeoutMs);
    },
  });
  expect(result).toMatchObject({ ok: false, code: "command_timeout" });
  expect(result.ok ? "" : result.message).toContain("login status");
  expect(observedTimeouts).toEqual([
    CODEX_PREFLIGHT_COMMAND_TIMEOUT_MS,
    CODEX_PREFLIGHT_COMMAND_TIMEOUT_MS,
  ]);
});

test("default preflight command runner kills a command at its deadline", async () => {
  const startedAt = performance.now();
  const result = await defaultCodexPreflightDependencies.run(
    ["/bin/sh", "-c", "while :; do :; done"],
    25,
  );
  expect(result.timedOut).toBeTrue();
  expect(performance.now() - startedAt).toBeLessThan(1_000);
});

test("the checked-in managed requirements template satisfies preflight without bypassing user-hook trust", async () => {
  const requirementsPath = new URL("../deploy/codex-requirements.toml", import.meta.url).pathname;
  const hookPath = new URL("./codex-hook.ts", import.meta.url).pathname;
  const statePath = new URL("./codex-state.ts", import.meta.url).pathname;
  const requirements = await Bun.file(requirementsPath).text();
  expect(requirements).not.toContain("allow_managed_hooks_only = true");
  expect(requirements).not.toContain("dangerously-bypass-hook-trust");

  expect(await preflightCodex({
    which: () => "/usr/local/bin/codex",
    run: async (argv) => argv.includes("--version")
      ? { code: 0, out: "codex-cli 0.146.0", err: "" }
      : argv.includes("status")
        ? { code: 0, out: "Logged in", err: "" }
        : { code: 0, out: "hooks stable true", err: "" },
    readText: (path) => {
      if (path === CODEX_REQUIREMENTS_PATH) return requirements;
      if (path.endsWith("codex-hook.ts")) return Bun.file(hookPath).text();
      if (path.endsWith("codex-state.ts")) return Bun.file(statePath).text();
      return null;
    },
    inspectPath: securePathInspection,
  })).toMatchObject({ ok: true, version: "0.146.0" });
});

test("unrestricted Codex permissions require explicit operator configuration", () => {
  const options = { bin: "/usr/local/bin/codex", cwd: "/srv/project", screen: "cs-demo", launchId, dbPath: "/srv/app/data/app.db" };
  expect(buildCodexInvocation(options)?.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(buildCodexInvocation(options)?.argv).not.toContain("-c");
  expect(buildCodexInvocation({ ...options, unrestricted: true })?.argv).toContain("--dangerously-bypass-approvals-and-sandbox");
});

test("unrestricted launches and resumes trust only the selected folder through a valid TOML table", () => {
  for (const cwd of ["/srv/project", "/srv/example.com/team's \"copy\"", "/srv/back\\slash\nnext\x7f"]) {
    for (const session of [null, resumeId]) {
      const invocation = buildCodexInvocation({
        bin: "codex", cwd, screen: "cs-demo", launchId, dbPath: "/tmp/app.db",
        unrestricted: true, resumeId: session,
      })!;
      const overrideIndex = invocation.argv.indexOf("-c");
      const override = invocation.argv[overrideIndex + 1]!;
      expect(override.startsWith("projects=")).toBe(true);
      expect(Bun.TOML.parse(override)).toEqual({ projects: { [cwd]: { trust_level: "trusted" } } });
      expect(invocation.argv).not.toContain("--dangerously-bypass-hook-trust");
      if (session) expect(invocation.argv.slice(-2)).toEqual(["resume", session]);
    }
  }
});
