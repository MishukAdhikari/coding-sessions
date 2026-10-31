import { childEnvironment } from "./child-env";
import { readCodexIdentity } from "./account-identity";
import { recordAccountLogin } from "./account-history";

export type CodexAuthState =
  | "idle"
  | "starting"
  | "awaiting_user"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled";

export interface CodexAuthPublicStatus {
  state: CodexAuthState;
  running: boolean;
  verificationUrl: string | null;
  userCode: string | null;
  message: string;
  error: string | null;
  expiresAt: number | null;
}

export interface CodexAuthProcess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(): void;
}

export interface CodexAuthProcessRunner {
  which(): string | null | Promise<string | null>;
  spawn(argv: readonly string[]): CodexAuthProcess;
}

export interface CodexAuthController {
  start(): Promise<CodexAuthPublicStatus>;
  status(): Promise<CodexAuthPublicStatus>;
  cancel(): Promise<CodexAuthPublicStatus>;
}

export interface CodexAuthControllerOptions {
  onAuthenticated?: () => void | Promise<void>;
  runner?: CodexAuthProcessRunner;
  now?: () => number;
  timeoutMs?: number;
  handshakeTimeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1_024;
const MAX_URL_LENGTH = 2_048;
const APPROVED_VERIFICATION_HOSTS = new Set([
  "auth.openai.com",
  "openai.com",
  "platform.openai.com",
  "chatgpt.com",
  "www.chatgpt.com",
]);

export const bunCodexAuthProcessRunner: CodexAuthProcessRunner = {
  which: () => Bun.which("codex"),
  spawn(argv) {
    const process = Bun.spawn([...argv], {
      env: childEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: process.stdout,
      stderr: process.stderr,
      exited: process.exited,
      kill() {
        if (process.exitCode === null) process.kill();
      },
    };
  },
};

const IDLE_STATUS: CodexAuthPublicStatus = {
  state: "idle",
  running: false,
  verificationUrl: null,
  userCode: null,
  message: "",
  error: null,
  expiresAt: null,
};

interface ActiveAttempt {
  id: number;
  bin: string;
  process: CodexAuthProcess;
  output: string;
  outputBytes: number;
  verificationUrl: string | null;
  userCode: string | null;
  timer: unknown;
  handshakeTimer: unknown;
}

function isApprovedVerificationUrl(candidate: string): boolean {
  if (candidate.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && APPROVED_VERIFICATION_HOSTS.has(hostname)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function findVerificationUrl(text: string): string | null {
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
    const candidate = match[0].replace(/[),.;!?]+$/, "");
    if (isApprovedVerificationUrl(candidate)) return candidate;
  }
  return null;
}

function findUserCode(text: string): string | null {
  return text.match(/\b[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8}){1,2}\b/)?.[0] ?? null;
}

function sanitizeError(text: string): string {
  let safe = text
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  safe = safe.replace(/https?:\/\/[^\s<>"']+/gi, "[link]");
  safe = safe
    .replace(/\b[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8}){1,2}\b/g, "[device code]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
  const lines = safe.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-8);
  return lines.join("\n").slice(-512);
}

async function readBounded(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes < MAX_OUTPUT_BYTES) {
      const remaining = MAX_OUTPUT_BYTES - bytes;
      result += decoder.decode(value.subarray(0, remaining), { stream: true });
    }
    bytes += value.byteLength;
  }
  return result + decoder.decode();
}

async function collectProcess(process: CodexAuthProcess) {
  const [out, err, code] = await Promise.all([
    readBounded(process.stdout),
    readBounded(process.stderr),
    process.exited,
  ]);
  return { code, out, err };
}

export function createCodexAuthController(options: CodexAuthControllerOptions = {}): CodexAuthController {
  const runner = options.runner ?? bunCodexAuthProcessRunner;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const setTimer = options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let publicStatus = { ...IDLE_STATUS };
  let active: ActiveAttempt | null = null;
  let operationId = 0;
  let startPromise: Promise<CodexAuthPublicStatus> | null = null;

  const snapshot = () => ({ ...publicStatus });

  function ingest(attempt: ActiveAttempt, chunk: Uint8Array, decoder: TextDecoder): void {
    if (active?.id !== attempt.id || attempt.outputBytes >= MAX_OUTPUT_BYTES) return;
    const remaining = MAX_OUTPUT_BYTES - attempt.outputBytes;
    attempt.output += decoder.decode(chunk.subarray(0, remaining), { stream: true });
    attempt.outputBytes += chunk.byteLength;
    attempt.verificationUrl ??= findVerificationUrl(attempt.output);
    attempt.userCode ??= findUserCode(attempt.output);
    if (attempt.verificationUrl && attempt.userCode && attempt.handshakeTimer !== null) {
      clearTimer(attempt.handshakeTimer);
      attempt.handshakeTimer = null;
    }
    publicStatus = {
      ...publicStatus,
      state: attempt.verificationUrl && attempt.userCode ? "awaiting_user" : "starting",
      running: true,
      verificationUrl: attempt.verificationUrl,
      userCode: attempt.userCode,
      message: attempt.verificationUrl && attempt.userCode
        ? "Open the verification URL and enter the one-time code."
        : "Starting Codex device login.",
    };
  }

  async function consume(attempt: ActiveAttempt, stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ingest(attempt, value, decoder);
    }
  }

  async function finishAttempt(
    attempt: ActiveAttempt,
    code: number,
  ): Promise<void> {
    if (active?.id !== attempt.id) return;
    if (attempt.handshakeTimer !== null) clearTimer(attempt.handshakeTimer);
    if (code !== 0) {
      clearTimer(attempt.timer);
      active = null;
      publicStatus = {
        ...IDLE_STATUS,
        state: "failed",
        message: "Codex device login failed.",
        error: "Codex device login did not complete.",
      };
      return;
    }

    let verification: Awaited<ReturnType<typeof collectProcess>>;
    try {
      const process = runner.spawn([attempt.bin, "login", "status"]);
      attempt.process = process;
      verification = await collectProcess(process);
    } catch (error) {
      clearTimer(attempt.timer);
      active = null;
      publicStatus = {
        ...IDLE_STATUS,
        state: "failed",
        message: "Codex device login failed.",
        error: sanitizeError(error instanceof Error ? error.message : "Codex login verification failed."),
      };
      return;
    }
    if (active?.id !== attempt.id) return;
    clearTimer(attempt.timer);
    if (verification.code === 0) await options.onAuthenticated?.();
    if (active?.id !== attempt.id) return;
    active = null;
    publicStatus = verification.code === 0
      ? { ...IDLE_STATUS, state: "succeeded", message: "Codex is authenticated." }
      : {
          ...IDLE_STATUS,
          state: "failed",
          message: "Codex device login failed.",
          error: "Codex login could not be verified.",
        };
  }

  async function begin(): Promise<CodexAuthPublicStatus> {
    const id = ++operationId;
    publicStatus = {
      ...IDLE_STATUS,
      state: "starting",
      running: true,
      message: "Starting Codex device login.",
    };
    let bin: string | null;
    try {
      bin = await runner.which();
    } catch (error) {
      if (id !== operationId) return snapshot();
      publicStatus = {
        ...IDLE_STATUS,
        state: "failed",
        message: "Codex device login failed.",
        error: sanitizeError(error instanceof Error ? error.message : "Codex CLI lookup failed."),
      };
      return snapshot();
    }
    if (id !== operationId) return snapshot();
    if (!bin) {
      publicStatus = {
        ...IDLE_STATUS,
        state: "failed",
        message: "Codex device login failed.",
        error: "Codex CLI is not installed.",
      };
      return snapshot();
    }

    let process: CodexAuthProcess;
    try {
      process = runner.spawn([bin, "login", "status"]);
    } catch (error) {
      publicStatus = {
        ...IDLE_STATUS,
        state: "failed",
        message: "Codex device login failed.",
        error: sanitizeError(error instanceof Error ? error.message : "Codex login status failed."),
      };
      return snapshot();
    }
    const attempt: ActiveAttempt = {
      id,
      bin,
      process,
      output: "",
      outputBytes: 0,
      verificationUrl: null,
      userCode: null,
      timer: null,
      handshakeTimer: null,
    };
    active = attempt;
    publicStatus = {
      ...IDLE_STATUS,
      state: "starting",
      running: true,
      message: "Starting Codex device login.",
      expiresAt: now() + timeoutMs,
    };
    attempt.timer = setTimer(() => {
      if (active?.id !== attempt.id) return;
      operationId++;
      active = null;
      if (attempt.handshakeTimer !== null) clearTimer(attempt.handshakeTimer);
      publicStatus = {
        ...IDLE_STATUS,
        state: "expired",
        message: "Codex device login expired.",
        error: "Codex device login expired. Start a new login attempt.",
      };
      try { attempt.process.kill(); } catch {}
    }, timeoutMs);

    const login = await collectProcess(process);
    if (active?.id !== attempt.id) return snapshot();
    if (login.code === 0) {
      clearTimer(attempt.timer);
      if (attempt.handshakeTimer !== null) clearTimer(attempt.handshakeTimer);
      active = null;
      publicStatus = { ...IDLE_STATUS, state: "succeeded", message: "Codex is authenticated." };
      return snapshot();
    }

    try {
      process = runner.spawn([bin, "login", "--device-auth"]);
    } catch (error) {
      clearTimer(attempt.timer);
      active = null;
      publicStatus = {
        ...IDLE_STATUS,
        state: "failed",
        message: "Codex device login failed.",
        error: sanitizeError(error instanceof Error ? error.message : "Codex login failed."),
      };
      return snapshot();
    }
    attempt.process = process;
    attempt.handshakeTimer = setTimer(() => {
      if (active?.id !== attempt.id || (attempt.verificationUrl && attempt.userCode)) return;
      operationId++;
      clearTimer(attempt.timer);
      active = null;
      publicStatus = {
        ...IDLE_STATUS,
        state: "failed",
        message: "Codex device login failed.",
        error: "Codex did not provide supported device-login instructions.",
      };
      try { attempt.process.kill(); } catch {}
    }, handshakeTimeoutMs);
    const stdout = consume(attempt, process.stdout);
    const stderr = consume(attempt, process.stderr);
    void (async () => {
      const code = await process.exited;
      await Promise.allSettled([stdout, stderr]);
      await finishAttempt(attempt, code);
    })();
    return snapshot();
  }

  return {
    async start() {
      if (startPromise) return startPromise;
      if (active) return snapshot();
      startPromise = begin();
      try {
        return await startPromise;
      } finally {
        startPromise = null;
      }
    },
    async status() {
      return snapshot();
    },
    async cancel() {
      if (!active && publicStatus.state !== "starting") return snapshot();
      operationId++;
      const attempt = active;
      active = null;
      publicStatus = {
        ...IDLE_STATUS,
        state: "cancelled",
        message: "Codex device login was cancelled.",
      };
      if (attempt) {
        clearTimer(attempt.timer);
        if (attempt.handshakeTimer !== null) clearTimer(attempt.handshakeTimer);
        try { attempt.process.kill(); } catch {}
      }
      return snapshot();
    },
  };
}

/** Process-wide controller used by the HTTP routes; tests create isolated controllers. */
export const codexAuth = createCodexAuthController({ onAuthenticated: async () => recordAccountLogin("codex", await readCodexIdentity()) });
