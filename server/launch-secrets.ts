/**
 * The secrets file each managed launch gets ($CS_SECRETS_FILE). A process's environment is
 * fixed when it starts, so a secret saved after a session launched never reaches it that
 * way. This file does: the app rewrites it whenever Secrets change or a secret request is
 * fulfilled, and the agent reads a value from it in a subshell when it needs one.
 *
 * Trust model: sessions run as the same Unix account as the server, which can already read
 * every session's environment through /proc/<pid>/environ. A 0600 file in a 0700 directory
 * is the same boundary as environment delivery, not a new one. Every launch receives every
 * secret, as a new session's environment does.
 *
 * The files hold plaintext, so they live in a runtime directory (CS_RUNTIME_DIR, else
 * XDG_RUNTIME_DIR, else the service's private /tmp), never in the backed-up data directory,
 * and a file is removed as soon as its launch is gone.
 */
import type { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

const LAUNCH_ID = /^[A-Za-z0-9-]{1,64}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Where the files go: a runtime directory that is not backed up and is cleared on reboot. */
export function launchSecretsDir(env: Record<string, string | undefined> = process.env): string {
  const runtime = env.CS_RUNTIME_DIR || env.XDG_RUNTIME_DIR;
  if (runtime) return join(runtime, "coding-sessions-secrets");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(tmpdir(), `coding-sessions-secrets-${uid}`);
}

export function launchSecretsPath(dir: string, launchId: string): string {
  if (!LAUNCH_ID.test(launchId)) throw new Error("Invalid launch id.");
  return join(dir, `${launchId}.env`);
}

/** One `export NAME='value'` line per secret; single quotes keep every byte literal. */
export function renderSecretsFile(env: Record<string, string>): string {
  const lines = [
    "# Coding Sessions secrets for this session. Rewritten by the app; do not edit.",
    "# Read only the name you need, without printing it, e.g.:",
    "#   ( . \"$CS_SECRETS_FILE\" && some-command --token-env NAME )",
  ];
  for (const name of Object.keys(env).sort()) {
    if (!ENV_NAME.test(name)) continue;
    lines.push(`export ${name}='${env[name]!.replaceAll("'", "'\\''")}'`);
  }
  return lines.join("\n") + "\n";
}

function privateDir(dir: string): void {
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("The launch secrets directory must be a real directory.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("The launch secrets directory belongs to another account.");
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** Atomic: a reader sees the old file or the new one, never half of either. */
export function writeLaunchSecrets(dir: string, launchId: string, env: Record<string, string>): string {
  const path = launchSecretsPath(dir, launchId);
  privateDir(dir);
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, renderSecretsFile(env), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return path;
}

export function removeLaunchSecrets(dir: string, launchId: string): void {
  try { rmSync(launchSecretsPath(dir, launchId), { force: true }); } catch {}
}

/**
 * What each launch's environment held when it started, as keyed hashes only, so a tool can
 * say whether a name is current, changed or missing there without ever storing a value.
 * The key is random per process and the map lives in memory: after a server restart the
 * answer is "unknown", never a guess.
 */
export function createLaunchFingerprints() {
  const key = randomBytes(32);
  const launches = new Map<string, Map<string, string>>();
  const digest = (value: string) => createHmac("sha256", key).update(value).digest("hex");
  return {
    record(launchId: string, env: Record<string, string>): void {
      launches.set(launchId, new Map(Object.entries(env).map(([name, value]) => [name, digest(value)])));
    },
    /** current: same value; outdated: changed since launch; missing: not there at launch; unknown: not recorded. */
    compare(launchId: string, name: string, value: string | undefined): "current" | "outdated" | "missing" | "unknown" {
      const recorded = launches.get(launchId);
      if (!recorded) return "unknown";
      const at = recorded.get(name);
      if (at === undefined) return "missing";
      if (value === undefined) return "outdated";
      return at === digest(value) ? "current" : "outdated";
    },
    forget(keep: Set<string>): void {
      for (const id of launches.keys()) if (!keep.has(id)) launches.delete(id);
    },
  };
}
export type LaunchFingerprints = ReturnType<typeof createLaunchFingerprints>;

/** The process-wide instance launches and the secrets routes share. */
export const launchSecrets = {
  dir: launchSecretsDir(),
  fingerprints: createLaunchFingerprints(),
  /**
   * At launch: write the file and remember what the environment held. Returns the env to
   * add (CS_SECRETS_FILE), or nothing if the file cannot be written; a launch never fails
   * because of this.
   */
  prepare(launchId: string, env: Record<string, string>): Record<string, string> {
    this.fingerprints.record(launchId, env);
    try { return { CS_SECRETS_FILE: writeLaunchSecrets(this.dir, launchId, env) }; } catch { return {}; }
  },
  path(launchId: string): string | null {
    try { return launchSecretsPath(this.dir, launchId); } catch { return null; }
  },
};

export interface RefreshDependencies {
  database: Database;
  dir: string;
  /** Built from cached source snapshots only; a refresh never forces a network sync. */
  env: () => Promise<Record<string, string>>;
}

/** Launch ids that still own a session row; their files are kept and rewritten. */
export function currentLaunchIds(database: Database): Set<string> {
  const rows = database.query("SELECT launch_id FROM launches WHERE launch_id IS NOT NULL AND phase != 'failed'").all() as Array<{ launch_id: string }>;
  return new Set(rows.map(row => row.launch_id).filter(id => LAUNCH_ID.test(id)));
}

let refreshing: Promise<unknown> = Promise.resolve();

/**
 * Rewrite every current launch's file and remove the files of launches that are gone.
 * Calls run one after another, so two quick changes cannot interleave their writes.
 * Never throws: a failure here must not break a secret save or a launch.
 */
export function refreshLaunchSecrets(deps: RefreshDependencies): Promise<{ written: number; removed: number }> {
  const run = refreshing.then(() => refreshOnce(deps));
  refreshing = run.catch(() => {});
  return run;
}

async function refreshOnce(deps: RefreshDependencies): Promise<{ written: number; removed: number }> {
  let written = 0;
  let removed = 0;
  try {
    const live = currentLaunchIds(deps.database);
    let names: string[] = [];
    try { names = readdirSync(deps.dir); } catch {}
    for (const name of names) {
      const id = name.endsWith(".env") ? name.slice(0, -4) : null;
      if (id !== null && !live.has(id)) { rmSync(join(deps.dir, name), { force: true }); removed++; }
    }
    if (!live.size) return { written, removed };
    const env = await deps.env();
    for (const id of live) {
      // A file that cannot be rewritten must not keep stale values.
      try { writeLaunchSecrets(deps.dir, id, env); written++; } catch { removeLaunchSecrets(deps.dir, id); }
    }
  } catch {}
  return { written, removed };
}
