import { rmSync, writeFileSync } from "node:fs";

/**
 * Settings an operator can change from the app. Each resolves as: a value saved
 * in Settings, else the server's environment (validated at startup by config.ts),
 * else a built-in default. Values are read where they are used, so a change
 * applies without a restart.
 */
export type ServerSettingName =
  | "defaultRepo" | "githubOwners" | "claudeAiEmail" | "agentPermissions" | "terminalMouse" | "updateChannel" | "trustWorkspaces";

export type SettingSource = "settings" | "server" | "default";

interface Definition {
  env: string;
  fallback: string;
  /** Turn a raw value into its stored form, or return an error message. */
  normalize(raw: string): { value: string } | { error: string };
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const OWNER_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const oneOf = (allowed: string[], error: string) => (raw: string) =>
  allowed.includes(raw.trim()) ? { value: raw.trim() } : { error };

export const DEFINITIONS: Record<ServerSettingName, Definition> = {
  defaultRepo: {
    env: "CS_DEFAULT_REPO", fallback: "",
    normalize: (raw) => {
      const value = raw.trim();
      return !value || REPO_RE.test(value) ? { value } : { error: "Default repository must be owner/repository." };
    },
  },
  githubOwners: {
    env: "CS_GITHUB_OWNERS", fallback: "",
    normalize: (raw) => {
      const owners = raw.split(",").map((owner) => owner.trim()).filter(Boolean);
      return owners.every((owner) => OWNER_RE.test(owner))
        ? { value: [...new Set(owners)].join(",") }
        : { error: "GitHub owners must be comma-separated GitHub account or organization names." };
    },
  },
  claudeAiEmail: {
    env: "CAI_EMAIL", fallback: "",
    normalize: (raw) => {
      const value = raw.trim();
      return !value || EMAIL_RE.test(value) ? { value } : { error: "Enter a valid email address." };
    },
  },
  agentPermissions: {
    env: "CS_AGENT_PERMISSIONS", fallback: "standard",
    normalize: oneOf(["standard", "unrestricted"], "Agent permissions must be standard or unrestricted."),
  },
  terminalMouse: {
    env: "CS_TERM_MOUSE", fallback: "on",
    normalize: oneOf(["on", "off"], "Terminal mouse must be on or off."),
  },
  trustWorkspaces: {
    env: "CS_TRUST_WORKSPACES", fallback: "off",
    normalize: oneOf(["on", "off"], "Trust app workspaces must be on or off."),
  },
  updateChannel: {
    env: "CS_APP_UPDATE_CHANNEL", fallback: "releases",
    normalize: oneOf(["releases", "main"], "Update channel must be releases or main."),
  },
};

export const SETTING_NAMES = Object.keys(DEFINITIONS) as ServerSettingName[];
const KEY_PREFIX = "server_setting:";
const META_PREFIX = "server_setting_meta:";
/** Who last changed a setting: the app (a signed-in browser) or an MCP client with the operator's confirmation. */
export type SettingChangedBy = "app" | "mcp";

export interface SettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface ServerSettingsOptions {
  store: SettingsStore;
  env?: Record<string, string | undefined>;
  /** Where the root updater reads the chosen channel; null when this host has no updater. */
  channelFile?: string | null;
  /** Called after a value changes, so caches tied to it can be dropped. */
  onChange?: (name: ServerSettingName) => void;
}

/** The environment's value in stored form: mouse is "off" only when set to off, as before. */
function serverValue(name: ServerSettingName, env: Record<string, string | undefined>): string | null {
  const raw = env[DEFINITIONS[name].env];
  if (raw === undefined) return null;
  if (name === "terminalMouse") return raw.trim() === "off" ? "off" : "on";
  if (name === "updateChannel") return raw.trim() === "main" ? "main" : "releases";
  if (name === "trustWorkspaces") return raw.trim() === "on" ? "on" : "off";
  const normalized = DEFINITIONS[name].normalize(raw);
  return "value" in normalized ? normalized.value : null;
}

export function createServerSettings(options: ServerSettingsOptions) {
  const env = options.env ?? process.env;
  const overrides = new Map<ServerSettingName, string>();
  for (const name of SETTING_NAMES) {
    const saved = options.store.get(KEY_PREFIX + name);
    if (saved === null) continue;
    const normalized = DEFINITIONS[name].normalize(saved);
    if ("value" in normalized) overrides.set(name, normalized.value);
  }

  const meta = (name: ServerSettingName): { by: SettingChangedBy; at: string } | null => {
    try {
      const raw = options.store.get(META_PREFIX + name);
      const m = raw ? JSON.parse(raw) : null;
      return m && (m.by === "app" || m.by === "mcp") && typeof m.at === "string" ? m : null;
    } catch { return null; }
  };

  const resolve = (name: ServerSettingName): { value: string; source: SettingSource } => {
    const override = overrides.get(name);
    if (override !== undefined) return { value: override, source: "settings" };
    const fromServer = serverValue(name, env);
    if (fromServer !== null) return { value: fromServer, source: "server" };
    return { value: DEFINITIONS[name].fallback, source: "default" };
  };

  // The root updater reads this file, so it always mirrors the stored choice.
  const writeChannelFile = (choice: string | undefined) => {
    if (!options.channelFile) return;
    if (choice === undefined) rmSync(options.channelFile, { force: true });
    else writeFileSync(options.channelFile, `${choice}\n`, { mode: 0o600 });
  };
  try { writeChannelFile(overrides.get("updateChannel")); } catch {}

  return {
    get: (name: ServerSettingName): string => resolve(name).value,
    owners: (): string[] => resolve("githubOwners").value.split(",").filter(Boolean),
    unrestricted: (): boolean => resolve("agentPermissions").value === "unrestricted",
    /** Claude Code's folder trust is pre-accepted for workspaces the app creates (repo, synced and handoff), never other paths. */
    trustWorkspaces: (): boolean => resolve("trustWorkspaces").value === "on",
    mouseEnabled: (): boolean => resolve("terminalMouse").value !== "off",
    channelAvailable: (): boolean => !!options.channelFile,

    describe() {
      return Object.fromEntries(SETTING_NAMES.map((name) => {
        const { value, source } = resolve(name);
        const changed = source === "settings" ? meta(name) : null;
        return [name, { value, source, serverValue: serverValue(name, env) ?? DEFINITIONS[name].fallback, ...(changed ? { changedBy: changed.by, changedAt: changed.at } : {}) }];
      })) as Record<ServerSettingName, { value: string; source: SettingSource; serverValue: string; changedBy?: SettingChangedBy; changedAt?: string }>;
    },

    set(name: ServerSettingName, raw: unknown, by: SettingChangedBy = "app"): { ok: true; value: string } | { ok: false; error: string } {
      if (typeof raw !== "string" || raw.length > 1024) return { ok: false, error: "Send the new value as text." };
      if (name === "updateChannel" && !options.channelFile) {
        return { ok: false, error: "This server does not update itself, so the update channel cannot be changed here." };
      }
      const normalized = DEFINITIONS[name].normalize(raw);
      if ("error" in normalized) return { ok: false, error: normalized.error };
      if (name === "updateChannel") {
        try { writeChannelFile(normalized.value); } catch { return { ok: false, error: "Could not save the update channel for the updater." }; }
      }
      options.store.set(KEY_PREFIX + name, normalized.value);
      // Only an MCP change is recorded: the app (a signed-in browser) is the default author.
      if (by === "mcp") options.store.set(META_PREFIX + name, JSON.stringify({ by, at: new Date().toISOString() }));
      else options.store.delete(META_PREFIX + name);
      overrides.set(name, normalized.value);
      options.onChange?.(name);
      return { ok: true, value: normalized.value };
    },

    reset(name: ServerSettingName): { ok: true } | { ok: false; error: string } {
      if (name === "updateChannel") {
        try { writeChannelFile(undefined); } catch { return { ok: false, error: "Could not save the update channel for the updater." }; }
      }
      options.store.delete(KEY_PREFIX + name);
      options.store.delete(META_PREFIX + name);
      overrides.delete(name);
      options.onChange?.(name);
      return { ok: true };
    },
  };
}

export type ServerSettings = ReturnType<typeof createServerSettings>;

export function isSettingName(value: unknown): value is ServerSettingName {
  return typeof value === "string" && (SETTING_NAMES as string[]).includes(value);
}
