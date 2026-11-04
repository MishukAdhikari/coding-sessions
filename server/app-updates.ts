import { readCsSetting } from "./environment";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";

export interface AppUpdatePaths {
  /** Written by the root updater; absent on hosts not set up by deploy/install-ubuntu. */
  status: string | null;
  /** The owner's opt-in. The updater reads only the word "on" from it. */
  flag: string;
  /** What the running release was built from. */
  version: string;
  channel: string;
}

export function appUpdatePaths(dataDir: string, env: Record<string, string | undefined> = process.env): AppUpdatePaths {
  const status = readCsSetting(env, "CS_APP_UPDATE_STATUS") ?? null;
  return {
    status: status && status.startsWith("/") ? status : null,
    flag: join(dataDir, "app-auto-update"),
    version: join(process.cwd(), ".source-version"),
    channel: readCsSetting(env, "CS_APP_UPDATE_CHANNEL") === "main" ? "main" : "releases",
  };
}

const RESULTS = new Set(["success", "failed", "up-to-date", "needs-admin"]);

/** Accept only the shape the updater writes; anything else reads as "never checked". */
export function parseUpdateStatus(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const text = (key: string) => typeof value[key] === "string" ? (value[key] as string).slice(0, 200) : null;
  const result = text("result");
  const finished = text("finished");
  if (!result || !RESULTS.has(result) || !finished || !Number.isFinite(Date.parse(finished))) return null;
  return { result, finished: new Date(finished).toISOString(), message: text("message") ?? "", version: text("version") };
}

/** `channel` reports the effective channel when Settings can change it; otherwise the startup value. */
export function createAppUpdates(paths: AppUpdatePaths, channel: () => string = () => paths.channel) {
  const read = (path: string) => readFile(path, "utf8").catch(() => null);
  return {
    async status() {
      const [flag, version, status] = await Promise.all([
        read(paths.flag),
        read(paths.version),
        paths.status ? read(paths.status) : Promise.resolve(null),
      ]);
      let last: ReturnType<typeof parseUpdateStatus> = null;
      try { last = status ? parseUpdateStatus(JSON.parse(status)) : null; } catch {}
      return {
        available: paths.status !== null,
        enabled: flag?.trim() === "on",
        channel: channel(),
        version: version?.trim() || null,
        last,
      };
    },
    async setEnabled(enabled: boolean) {
      if (!paths.status) return { ok: false as const, error: "Automatic updates need an install made with deploy/install-ubuntu." };
      if (enabled) await writeFile(paths.flag, "on\n", { mode: 0o600 });
      else await rm(paths.flag, { force: true });
      return { ok: true as const };
    },
  };
}

