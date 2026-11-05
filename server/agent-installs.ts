/**
 * Install coding agents on this server from the app or the `cs` CLI.
 *
 * Runs deploy/install-provider-clis as the account the app already runs as — the
 * same script an operator runs over SSH, so there is one install path. It never
 * runs as root (the script refuses), signs in to nothing, and installs only names
 * from the fixed list below. One install runs at a time.
 */
import { childEnvironment } from "./child-env";

export const INSTALLABLE_AGENTS = [
  { id: "claude", label: "Claude Code", preset: false },
  { id: "codex", label: "Codex", preset: false },
  { id: "command-code", label: "Command Code", preset: false },
  { id: "gemini", label: "Gemini CLI", preset: true },
  { id: "kimi", label: "Kimi Code", preset: true },
  { id: "qwen", label: "Qwen Code", preset: true },
  { id: "opencode", label: "opencode", preset: true },
] as const;
export type InstallableAgent = typeof INSTALLABLE_AGENTS[number]["id"];

export interface InstallJob {
  agents: InstallableAgent[];
  running: boolean;
  result: "running" | "success" | "failed";
  startedAt: string;
  finishedAt: string | null;
  /** The last lines the installer printed: npm progress and each agent's version. */
  output: string;
}

const OUTPUT_MAX = 8000;
const TIMEOUT_MS = 15 * 60_000;

export interface AgentInstallerOptions {
  script?: string;
  spawn?: (argv: string[]) => { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill: () => void };
  now?: () => Date;
  /** Called after an install finishes, so cached versions are read again. */
  onFinished?: () => void;
}

export function parseAgents(value: unknown): { ok: true; agents: InstallableAgent[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: "Name at least one agent to install." };
  const known = new Set<string>(INSTALLABLE_AGENTS.map(agent => agent.id));
  const unknown = value.filter(name => typeof name !== "string" || !known.has(name));
  if (unknown.length) return { ok: false, error: `Unknown agent: ${unknown.map(String).join(", ")}. Choose from ${[...known].join(", ")}.` };
  return { ok: true, agents: [...new Set(value as InstallableAgent[])] };
}

export function createAgentInstaller(options: AgentInstallerOptions = {}) {
  const script = options.script ?? new URL("../deploy/install-provider-clis", import.meta.url).pathname;
  const spawn = options.spawn ?? ((argv: string[]) => Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnvironment() }));
  const now = options.now ?? (() => new Date());
  let job: InstallJob | null = null;

  const append = (text: string) => {
    if (!job) return;
    job.output = (job.output + text).slice(-OUTPUT_MAX);
  };
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
  };

  return {
    status(): InstallJob | null {
      return job ? { ...job, agents: [...job.agents] } : null;
    },
    start(input: unknown): { ok: true; job: InstallJob } | { ok: false; error: string; status: number } {
      const parsed = parseAgents(input);
      if (!parsed.ok) return { ...parsed, status: 422 };
      if (job?.running) return { ok: false, error: `Already installing ${job.agents.join(", ")}. Wait for it to finish.`, status: 409 };
      const current: InstallJob = job = { agents: parsed.agents, running: true, result: "running", startedAt: now().toISOString(), finishedAt: null, output: "" };
      let child: ReturnType<typeof spawn>;
      try { child = spawn(["bash", script, ...parsed.agents]); }
      catch {
        Object.assign(current, { running: false, result: "failed", finishedAt: now().toISOString(), output: "The installer could not be started on this server." });
        return { ok: true, job: { ...current } };
      }
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      void Promise.all([drain(child.stdout), drain(child.stderr), child.exited]).then(([, , code]) => code, () => 1).then(code => {
        clearTimeout(timer);
        Object.assign(current, { running: false, result: code === 0 ? "success" : "failed", finishedAt: now().toISOString() });
        options.onFinished?.();
      });
      return { ok: true, job: { ...current } };
    },
  };
}

export type AgentInstaller = ReturnType<typeof createAgentInstaller>;
