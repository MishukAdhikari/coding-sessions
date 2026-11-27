/** Secret naming rules, free of storage imports so any module (connectors too) can use them. */

/** What a CLI would actually read; same rule as a Command's token env var. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Names a stored secret may not take: what the session holder, the shell, the
 * dynamic loader, or this app's own session plumbing depends on. The operator can
 * already run anything, so this guards against accidents, not attacks: a pasted
 * PATH or LD_PRELOAD would break every launch in a way that is hard to trace.
 */
const RESERVED = new Set([
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "TERM", "PWD", "OLDPWD", "SHLVL", "IFS", "ENV", "BASH_ENV",
  "PROMPT_COMMAND", "SHELLOPTS", "BASHOPTS", "PS1", "PS2", "PS4", "CDPATH", "GLOBIGNORE", "NODE_OPTIONS",
  "SSH_AUTH_SOCK", "TMPDIR", "SCREENDIR", "CREDENTIALS_DIRECTORY",
]);
const RESERVED_PREFIXES = ["CS_", "LD_", "DYLD_", "ZMX_", "BASH_FUNC", "XDG_"];
export function reservedName(name: string): boolean {
  return RESERVED.has(name) || RESERVED_PREFIXES.some(prefix => name.startsWith(prefix));
}

