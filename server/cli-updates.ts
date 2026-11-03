import { readCsSetting } from "./environment";
import { childEnvironment } from "./child-env";
import { homedir } from "node:os";
import { join } from "node:path";

type CommandResult = { code: number; out: string };
type Runner = (argv: string[]) => Promise<CommandResult>;
export type UpdateAction = "enable" | "disable" | "run";

export function updateSettings(env: Record<string, string | undefined> = process.env) {
  const timer = readCsSetting(env, "CS_CLI_UPDATE_TIMER") ?? "update-coding-clis.timer";
  const service = readCsSetting(env, "CS_CLI_UPDATE_SERVICE") ?? "update-coding-clis.service";
  if (!/^[a-zA-Z0-9_@.-]+\.timer$/.test(timer) || !/^[a-zA-Z0-9_@.-]+\.service$/.test(service)
    || timer.startsWith("-") || service.startsWith("-")) throw new Error("Invalid CLI update unit name.");
  return { timer, service, controllable: readCsSetting(env, "CS_CLI_UPDATE_CONTROL") !== "0" };
}
const VERSION_COMMANDS: Array<{ name: string; argv: string[] }> = [
  { name: "codex", argv: ["codex", "--version"] },
  { name: "claude", argv: ["claude", "--version"] },
  { name: "command-code", argv: ["command-code", "--no-auto-update", "--version"] },
];

async function run(argv: string[]): Promise<CommandResult> {
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: childEnvironment() });
    const timeout = setTimeout(() => child.kill(), 10_000);
    try {
      const out = await new Response(child.stdout).text();
      return { code: await child.exited, out };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return { code: 1, out: "" };
  }
}

function properties(output: string): Map<string, string> {
  return new Map(output.trim().split("\n").map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}

function timestamp(value: string | undefined): string | null {
  if (!value || value === "n/a") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function readSavedStatus(): Promise<unknown> {
  return Bun.file(join(homedir(), ".local/state/coding-cli-updates/status.json")).json().catch(() => null);
}

function savedStatus(value: unknown) {
  if (!value || typeof value !== "object" || !("started" in value) || typeof value.started !== "string"
    || !("finished" in value) || !(value.finished === null || typeof value.finished === "string")
    || !("result" in value) || !["running", "success", "failed"].includes(String(value.result))) return null;
  const started = timestamp(value.started);
  if (!started) return null;
  return { started, finished: timestamp(value.finished ?? undefined), result: value.result };
}

export function createCliUpdates(execute: Runner = run, readHistory: () => Promise<unknown> = readSavedStatus, settings = updateSettings()) {
  let versionsCache: { until: number; value: Record<string, string | null> } | null = null;
  async function versions() {
    if (versionsCache && versionsCache.until > Date.now()) return versionsCache.value;
    const entries = await Promise.all(VERSION_COMMANDS.map(async ({ name, argv }): Promise<[string, string | null]> => {
      const result = await execute(argv);
      return [name, result.code === 0 ? result.out.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0] ?? null : null];
    }));
    const value = Object.fromEntries(entries);
    versionsCache = { until: Date.now() + 30_000, value };
    return value;
  }
  return {
    async status() {
      const [timerResult, serviceResult, installedVersions, history] = await Promise.all([
        execute(["systemctl", "show", settings.timer, "--property=LoadState,ActiveState,UnitFileState,NextElapseUSecRealtime"]),
        execute(["systemctl", "show", settings.service, "--property=LoadState,ActiveState,Result,ExecMainStartTimestamp,ExecMainExitTimestamp"]),
        versions(),
        readHistory().then(savedStatus),
      ]);
      const timer = properties(timerResult.out);
      const service = properties(serviceResult.out);
      if (timerResult.code !== 0 || serviceResult.code !== 0 || timer.get("LoadState") !== "loaded" || service.get("LoadState") !== "loaded") {
        return { available: false, versions: installedVersions };
      }
      const running = ["activating", "active", "deactivating"].includes(service.get("ActiveState") ?? "");
      const lastStarted = history?.started ?? timestamp(service.get("ExecMainStartTimestamp"));
      return {
        available: true,
        controllable: settings.controllable,
        enabled: timer.get("UnitFileState") === "enabled" && timer.get("ActiveState") === "active",
        running,
        nextRun: timestamp(timer.get("NextElapseUSecRealtime")),
        lastStarted,
        lastFinished: history?.finished ?? timestamp(service.get("ExecMainExitTimestamp")),
        result: running ? "running" : history ? history.result === "success" ? "success" : "failed"
          : lastStarted ? service.get("Result") === "success" ? "success" : "failed" : "never",
        versions: installedVersions,
      };
    },
    async control(action: UpdateAction) {
      if (!settings.controllable) return { ok: false, error: "CLI updates are managed by the server administrator." };
      const argv = action === "run"
        ? ["sudo", "-n", "/usr/bin/systemctl", "start", "--no-block", settings.service]
        : ["sudo", "-n", "/usr/bin/systemctl", action, "--now", settings.timer];
      const result = await execute(argv);
      if (result.code !== 0) return { ok: false, error: "Could not change CLI updates. Check the server timer and update permissions." };
      versionsCache = null;
      return { ok: true };
    },
  };
}

export const cliUpdates = createCliUpdates();
