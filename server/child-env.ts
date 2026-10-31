import { readCsSetting } from "./environment";
type Environment = Record<string, string | undefined>;
const SAFE_NAMES = new Set([
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TZ",
  "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK", "ZMX_DIR", "ZMX_NO_DETACH_KEY", "SCREENDIR",
]);

/** Credentials enter only through explicit per-provider overrides, not the service's .env. */
export function childEnvironment(overrides: Environment = {}, source: Environment = process.env): Environment {
  const mode = readCsSetting(source, "CS_CHILD_ENV") ?? "filtered";
  if (!["filtered", "inherit"].includes(mode)) throw new Error("CS_CHILD_ENV must be filtered or inherit.");
  const passthrough = (readCsSetting(source, "CS_PASSTHROUGH_ENV") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (passthrough.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error("Invalid CS_PASSTHROUGH_ENV name.");
  const env = Object.fromEntries(Object.entries(source).filter(([name]) =>
    mode === "inherit" || SAFE_NAMES.has(name) || /^LC_[A-Z_]+$/.test(name) || passthrough.includes(name)));
  // Even compatibility mode must not bulk-forward systemd credentials or pointers to app keys.
  for (const name of ["CREDENTIALS_DIRECTORY", "CS_ADMIN_PASSWORD_FILE", "CS_TOKEN_KEY_FILE"]) {
    delete env[name];
    if (name.startsWith("CS_")) delete env[`X${name}`];
  }
  return { ...env, ...overrides };
}
