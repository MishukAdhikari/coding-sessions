import { expect, test } from "bun:test";
import {
  createCodexAuthController,
  type CodexAuthProcess,
  type CodexAuthProcessRunner,
} from "./codex-auth";

function completedProcess(code: number, out = "", err = ""): CodexAuthProcess {
  return {
    stdout: new Response(out).body,
    stderr: new Response(err).body,
    exited: Promise.resolve(code),
    kill() {},
  };
}

function runningProcess(out: string) {
  let resolveExit!: (code: number) => void;
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let killed = false;
  let finished = false;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
      controller.enqueue(new TextEncoder().encode(out));
    },
  });
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    stdoutController.close();
    resolveExit(code);
  };
  const process: CodexAuthProcess = {
    stdout,
    stderr: new Response("").body,
    exited,
    kill() {
      killed = true;
      finish(130);
    },
  };
  return { process, exit: finish, wasKilled: () => killed };
}

async function eventuallyStatus(
  auth: ReturnType<typeof createCodexAuthController>,
  state: string,
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = await auth.status();
    if (status.state === state) return status;
    await Bun.sleep(0);
  }
  return auth.status();
}

function queuedRunner(processes: CodexAuthProcess[]) {
  const calls: string[][] = [];
  const runner: CodexAuthProcessRunner = {
    which: () => "/usr/bin/codex",
    spawn(argv) {
      calls.push([...argv]);
      const process = processes.shift();
      if (!process) throw new Error("Unexpected process spawn");
      return process;
    },
  };
  return { calls, runner };
}

function manualTimers() {
  let nextId = 1;
  const scheduled = new Map<number, { callback: () => void; delayMs: number }>();
  return {
    setTimer(callback: () => void, delayMs: number) {
      const id = nextId++;
      scheduled.set(id, { callback, delayMs });
      return id;
    },
    clearTimer(handle: unknown) {
      scheduled.delete(handle as number);
    },
    fire(delayMs: number) {
      const timer = [...scheduled.entries()].find(([, value]) => value.delayMs === delayMs);
      if (!timer) throw new Error(`No timer scheduled for ${delayMs}ms`);
      scheduled.delete(timer[0]);
      timer[1].callback();
    },
  };
}

test("already-authenticated operators get a safe success status", async () => {
  const { calls, runner } = queuedRunner([
    completedProcess(0, "Logged in using ChatGPT"),
  ]);
  const auth = createCodexAuthController({ runner });

  expect(await auth.start()).toEqual({
    state: "succeeded",
    running: false,
    verificationUrl: null,
    userCode: null,
    message: "Codex is authenticated.",
    error: null,
    expiresAt: null,
  });
  expect(calls).toEqual([["/usr/bin/codex", "login", "status"]]);
});

test("starting after success rechecks current login status", async () => {
  const { calls, runner } = queuedRunner([
    completedProcess(0),
    completedProcess(0),
  ]);
  const auth = createCodexAuthController({ runner });

  expect((await auth.start()).state).toBe("succeeded");
  expect((await auth.start()).state).toBe("succeeded");
  expect(calls).toEqual([
    ["/usr/bin/codex", "login", "status"],
    ["/usr/bin/codex", "login", "status"],
  ]);
});

test("device login exposes only approved browser instructions", async () => {
  const login = runningProcess([
    "Open https://auth.openai.com/codex/device in your browser",
    "Enter code ABCD-EFGH",
    "Diagnostic token sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ].join("\n"));
  const { calls, runner } = queuedRunner([
    completedProcess(1, "", "Not logged in"),
    login.process,
  ]);
  const auth = createCodexAuthController({ runner });

  await auth.start();
  expect(await auth.start()).toEqual(await auth.status());
  const status = await eventuallyStatus(auth, "awaiting_user");

  expect(status).toEqual({
    state: "awaiting_user",
    running: true,
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    message: "Open the verification URL and enter the one-time code.",
    error: null,
    expiresAt: expect.any(Number),
  });
  expect(JSON.stringify(status)).not.toContain("sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  expect(calls).toEqual([
    ["/usr/bin/codex", "login", "status"],
    ["/usr/bin/codex", "login", "--device-auth"],
  ]);
});

test("a completed device flow succeeds only after login status verifies it", async () => {
  const login = runningProcess("https://auth.openai.com/codex/device\nWXYZ-1234");
  const { calls, runner } = queuedRunner([
    completedProcess(1),
    login.process,
    completedProcess(0, "Logged in using ChatGPT"),
  ]);
  const auth = createCodexAuthController({ runner });

  await auth.start();
  expect((await eventuallyStatus(auth, "awaiting_user")).state).toBe("awaiting_user");
  login.exit(0);

  expect(await eventuallyStatus(auth, "succeeded")).toEqual({
    state: "succeeded",
    running: false,
    verificationUrl: null,
    userCode: null,
    message: "Codex is authenticated.",
    error: null,
    expiresAt: null,
  });
  expect(calls).toEqual([
    ["/usr/bin/codex", "login", "status"],
    ["/usr/bin/codex", "login", "--device-auth"],
    ["/usr/bin/codex", "login", "status"],
  ]);
});

test("an expired attempt kills its child and clears the one-time code", async () => {
  const login = runningProcess("https://auth.openai.com/codex/device\nTIME-OUT1");
  const { runner } = queuedRunner([completedProcess(1), login.process]);
  const timers = manualTimers();
  const auth = createCodexAuthController({
    runner,
    now: () => 10_000,
    timeoutMs: 30_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await auth.start();
  expect((await eventuallyStatus(auth, "awaiting_user")).expiresAt).toBe(40_000);
  timers.fire(30_000);

  expect(login.wasKilled()).toBe(true);
  expect(await auth.status()).toEqual({
    state: "expired",
    running: false,
    verificationUrl: null,
    userCode: null,
    message: "Codex device login expired.",
    error: "Codex device login expired. Start a new login attempt.",
    expiresAt: null,
  });
});

test("unsupported device instructions fail before the full login timeout", async () => {
  const login = runningProcess("Visit https://example.com/device\nEnter WAIT-1234");
  const { runner } = queuedRunner([completedProcess(1), login.process]);
  const timers = manualTimers();
  const auth = createCodexAuthController({
    runner,
    timeoutMs: 30_000,
    handshakeTimeoutMs: 5_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await auth.start();
  expect((await eventuallyStatus(auth, "starting")).verificationUrl).toBeNull();
  timers.fire(5_000);

  expect(login.wasKilled()).toBe(true);
  expect(await auth.status()).toEqual({
    state: "failed",
    running: false,
    verificationUrl: null,
    userCode: null,
    message: "Codex device login failed.",
    error: "Codex did not provide supported device-login instructions.",
    expiresAt: null,
  });
});

test("cancel is idempotent and stops the active login child", async () => {
  const login = runningProcess("https://auth.openai.com/codex/device\nCANC-EL12");
  const { calls, runner } = queuedRunner([completedProcess(1), login.process]);
  const auth = createCodexAuthController({ runner });

  await auth.start();
  expect((await eventuallyStatus(auth, "awaiting_user")).state).toBe("awaiting_user");
  const cancelled = await auth.cancel();

  expect(login.wasKilled()).toBe(true);
  expect(cancelled).toEqual({
    state: "cancelled",
    running: false,
    verificationUrl: null,
    userCode: null,
    message: "Codex device login was cancelled.",
    error: null,
    expiresAt: null,
  });
  expect(await auth.cancel()).toEqual(cancelled);
  expect(calls).toHaveLength(2);
});

test("cancel also stops a login-status check still in progress", async () => {
  const statusCheck = runningProcess("");
  const { calls, runner } = queuedRunner([statusCheck.process]);
  const auth = createCodexAuthController({ runner });

  const starting = auth.start();
  await Bun.sleep(0);
  expect((await auth.status()).state).toBe("starting");

  expect((await auth.cancel()).state).toBe("cancelled");
  expect(statusCheck.wasKilled()).toBe(true);
  expect((await starting).state).toBe("cancelled");
  expect(calls).toEqual([["/usr/bin/codex", "login", "status"]]);
});

test("a failed device-process spawn is sanitized and retryable", async () => {
  const calls: string[][] = [];
  const runner: CodexAuthProcessRunner = {
    which: () => "/usr/bin/codex",
    spawn(argv) {
      calls.push([...argv]);
      if (argv.at(-1) === "status") return completedProcess(1);
      throw new Error("spawn failed with https://auth.openai.com/codex/device RETR-Y123 sk-super-secret-value");
    },
  };
  const auth = createCodexAuthController({ runner });

  expect(await auth.start()).toMatchObject({
    state: "failed",
    error: "spawn failed with [link] [device code] [redacted]",
  });
  expect(await auth.start()).toMatchObject({ state: "failed" });
  expect(calls).toEqual([
    ["/usr/bin/codex", "login", "status"],
    ["/usr/bin/codex", "login", "--device-auth"],
    ["/usr/bin/codex", "login", "status"],
    ["/usr/bin/codex", "login", "--device-auth"],
  ]);
});

test("unapproved or over-limit verification URLs never become public", async () => {
  const output = [
    "https://unapproved.openai.com/device",
    "SAFE-1234",
    "x".repeat(17_000),
    "https://auth.openai.com/codex/device",
  ].join("\n");
  const login = runningProcess(output);
  const { runner } = queuedRunner([completedProcess(1), login.process]);
  const auth = createCodexAuthController({ runner });

  await auth.start();
  const status = await eventuallyStatus(auth, "starting");

  expect(status.verificationUrl).toBeNull();
  expect(status.userCode).toBe("SAFE-1234");
  expect(JSON.stringify(status)).not.toContain("unapproved.openai.com");
  await auth.cancel();
});

test("device-process errors never expose terminal output", async () => {
  const login = runningProcess([
    "https://chatgpt.com/device",
    "FAIL-1234",
    "Bearer very-secret-bearer-value",
  ].join("\n"));
  const { runner } = queuedRunner([completedProcess(1), login.process]);
  const auth = createCodexAuthController({ runner });

  await auth.start();
  await eventuallyStatus(auth, "awaiting_user");
  login.exit(1);
  const status = await eventuallyStatus(auth, "failed");

  expect(status).toMatchObject({
    state: "failed",
    running: false,
    verificationUrl: null,
    userCode: null,
    message: "Codex device login failed.",
    error: "Codex device login did not complete.",
  });
  expect(JSON.stringify(status)).not.toContain("very-secret-bearer-value");
});

test("a zero device exit is still failure when login status rejects it", async () => {
  const login = runningProcess("https://auth.openai.com/codex/device\nNOPE-1234");
  const { runner } = queuedRunner([
    completedProcess(1),
    login.process,
    completedProcess(1, "", "Not logged in: sk-verification-secret"),
  ]);
  const auth = createCodexAuthController({ runner });

  await auth.start();
  await eventuallyStatus(auth, "awaiting_user");
  login.exit(0);
  const status = await eventuallyStatus(auth, "failed");

  expect(status.error).toBe("Codex login could not be verified.");
  expect(status.verificationUrl).toBeNull();
  expect(status.userCode).toBeNull();
});

test("idle cancellation and a missing CLI are safe and idempotent", async () => {
  let spawnCount = 0;
  const auth = createCodexAuthController({
    runner: {
      which: () => null,
      spawn() {
        spawnCount++;
        return completedProcess(127);
      },
    },
  });

  expect((await auth.cancel()).state).toBe("idle");
  expect(await auth.start()).toMatchObject({
    state: "failed",
    error: "Codex CLI is not installed.",
  });
  expect(spawnCount).toBe(0);
});

test("binary lookup failures become sanitized public failures", async () => {
  const auth = createCodexAuthController({
    runner: {
      which() {
        throw new Error("lookup failed with sk-binary-lookup-secret");
      },
      spawn() {
        throw new Error("must not spawn");
      },
    },
  });

  expect(await auth.start()).toMatchObject({
    state: "failed",
    message: "Codex device login failed.",
    error: "lookup failed with [redacted]",
  });
});

test("login history callback requires a newly completed and verified device flow", async () => {
  let recorded = 0;
  const already = queuedRunner([completedProcess(0)]);
  const existing = createCodexAuthController({ runner: already.runner, onAuthenticated: () => { recorded++; } });
  await existing.start();
  await existing.status();
  expect(recorded).toBe(0);
  for (const verification of [1, 0]) {
    const login = runningProcess("https://auth.openai.com/codex/device\nHIST-1234");
    const { runner } = queuedRunner([completedProcess(1), login.process, completedProcess(verification)]);
    const auth = createCodexAuthController({ runner, onAuthenticated: () => { recorded++; } });
    await auth.start();
    await eventuallyStatus(auth, "awaiting_user");
    login.exit(0);
    await eventuallyStatus(auth, verification === 0 ? "succeeded" : "failed");
    await auth.status();
    await auth.status();
    expect(recorded).toBe(verification === 0 ? 1 : 0);
  }
});

test("successful device login waits for the identity-history callback", async () => {
  const login = runningProcess("https://auth.openai.com/codex/device\nHIST-1234");
  const { runner } = queuedRunner([completedProcess(1), login.process, completedProcess(0)]);
  let finishHistory!: () => void;
  const history = new Promise<void>(resolve => { finishHistory = resolve; });
  const auth = createCodexAuthController({ runner, onAuthenticated: () => history });
  await auth.start();
  await eventuallyStatus(auth, "awaiting_user");
  login.exit(0);
  await Bun.sleep(0);
  expect((await auth.status()).state).not.toBe("succeeded");
  finishHistory();
  expect((await eventuallyStatus(auth, "succeeded")).state).toBe("succeeded");
});
