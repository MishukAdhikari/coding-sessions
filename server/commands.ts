/**
 * The Commands registry — operator-registered CLI agents that launch as Sessions.
 *
 * Everything here exists to keep one promise: a definition the operator types in a
 * browser becomes an argv, never a shell string. `bin` is resolved and checked for
 * the executable bit at registration; `args` stay a list of discrete tokens; the
 * launch line quotes each token exactly once. A label of `; rm -rf /` is data.
 */
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Database } from "bun:sqlite";
import { db } from "./db";
import { sealSecret, openSecret, type SecretCodec } from "./secrets";
import { COMMAND_SLUG_RE, commandProviderId, type CommandProvider } from "./session-provider";

export interface CustomCommand {
  id: number;
  slug: string;
  provider: CommandProvider;
  label: string;
  bin: string;
  args: string[];
  /** Env var this agent's CLI reads its credential from, e.g. GEMINI_API_KEY. */
  envVar: string | null;
  /** Whether a token is stored. The token itself never leaves the server. */
  hasToken: boolean;
  createdAt: number;
}

interface CommandRow {
  id: number;
  slug: string;
  label: string;
  bin: string;
  args: string;
  env_var: string | null;
  token: string | null;
  created_at: number;
}

const LABEL_MAX = 40;
const TOKEN_MAX = 4096;
/** POSIX-ish env var name: what a CLI would actually read. */
export const ENV_VAR_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ARG_MAX = 200;
const ARGS_MAX = 24;

/** Control characters and NUL can't survive a command line intact — refuse them outright. */
const hasControlChars = (value: string) => /[\u0000-\u001f\u007f]/.test(value);

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31)
    .replace(/-+$/, "");
}

/** Resolve a binary the way the launch will: an absolute path, or a name on PATH. */
export function resolveBin(bin: string): { ok: true; path: string } | { ok: false; error: string } {
  const value = bin.trim();
  if (!value) return { ok: false, error: "Give the command a binary to run." };
  if (hasControlChars(value)) return { ok: false, error: "That binary path contains control characters." };
  if (value.length > 512) return { ok: false, error: "That binary path is too long." };

  const path = isAbsolute(value) ? value : Bun.which(value);
  if (!path) return { ok: false, error: `“${value}” is not on the server's PATH. Use an absolute path.` };
  try {
    if (!statSync(path).isFile()) return { ok: false, error: `“${path}” is not a file.` };
    accessSync(path, constants.X_OK);
  } catch {
    return { ok: false, error: `“${path}” does not exist or is not executable by the server.` };
  }
  return { ok: true, path };
}

/**
 * Turn one typed line into discrete arguments the way a shell would quote them —
 * `-c 'sleep 300'` is two arguments, not three. The result is still a list, so the
 * launch quotes each token exactly once and nothing here can start a second command.
 */
export function tokenizeArgs(line: string): { ok: true; args: string[] } | { ok: false; error: string } {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (quote === '"' && ch === "\\" && i + 1 < line.length) { current += line[++i]; continue; }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === "\\" && i + 1 < line.length) { current += line[++i]; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { args.push(current); current = ""; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) return { ok: false, error: "That argument line has an unclosed quote." };
  if (started) args.push(current);
  return { ok: true, args };
}

export type CommandDraft = { label: string; bin: string; args: string[]; envVar: string | null };

export function validateDraft(input: unknown): { ok: true; draft: CommandDraft & { slug: string } } | { ok: false; error: string } {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};

  const label = String(body.label ?? "").trim();
  if (!label) return { ok: false, error: "Give the command a name." };
  if (label.length > LABEL_MAX) return { ok: false, error: `Keep the name under ${LABEL_MAX} characters.` };
  if (hasControlChars(label)) return { ok: false, error: "That name contains control characters." };

  const slug = slugify(label);
  if (!COMMAND_SLUG_RE.test(slug)) {
    return { ok: false, error: "That name has no letters or numbers to build an id from." };
  }

  // Callers may send a list (API) or one typed line (the Commands sheet).
  let rawArgs: unknown = body.args === undefined || body.args === null ? [] : body.args;
  if (typeof body.argsLine === "string") {
    const tokenized = tokenizeArgs(body.argsLine);
    if (!tokenized.ok) return tokenized;
    rawArgs = tokenized.args;
  }
  if (!Array.isArray(rawArgs)) return { ok: false, error: "Arguments must be a list." };
  if (rawArgs.length > ARGS_MAX) return { ok: false, error: `Keep it under ${ARGS_MAX} arguments.` };
  const args: string[] = [];
  for (const raw of rawArgs) {
    if (typeof raw !== "string") return { ok: false, error: "Every argument must be text." };
    const arg = raw.trim();
    if (!arg) continue;
    if (arg.length > ARG_MAX) return { ok: false, error: "One of those arguments is too long." };
    if (hasControlChars(arg)) return { ok: false, error: "An argument contains control characters." };
    args.push(arg);
  }

  const rawEnv = body.envVar === undefined || body.envVar === null ? "" : String(body.envVar).trim();
  if (rawEnv && !ENV_VAR_RE.test(rawEnv)) {
    return { ok: false, error: "That env var name should look like GEMINI_API_KEY — capitals, digits and underscores." };
  }

  const resolved = resolveBin(String(body.bin ?? ""));
  if (!resolved.ok) return resolved;

  return { ok: true, draft: { label, slug, bin: resolved.path, args, envVar: rawEnv || null } };
}

const toCommand = (row: CommandRow): CustomCommand => ({
  id: row.id,
  slug: row.slug,
  provider: commandProviderId(row.slug),
  label: row.label,
  bin: row.bin,
  args: parseArgs(row.args),
  envVar: row.env_var,
  hasToken: !!row.token,
  createdAt: row.created_at,
});

/** A row written by an older build, or by hand, must not crash the list. */
function parseArgs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

export function listCommands(database: Database = db): CustomCommand[] {
  return (database.query("SELECT id, slug, label, bin, args, env_var, token, created_at FROM custom_commands ORDER BY label COLLATE NOCASE")
    .all() as CommandRow[]).map(toCommand);
}

export function findCommand(slug: string, database: Database = db): CustomCommand | null {
  if (!COMMAND_SLUG_RE.test(slug)) return null;
  const row = database.query("SELECT id, slug, label, bin, args, env_var, token, created_at FROM custom_commands WHERE slug = ?")
    .get(slug) as CommandRow | null;
  return row ? toCommand(row) : null;
}

export function createCommand(input: unknown, database: Database = db): { ok: true; command: CustomCommand } | { ok: false; error: string } {
  const validated = validateDraft(input);
  if (!validated.ok) return validated;
  const { label, slug, bin, args, envVar } = validated.draft;

  if (findCommand(slug, database)) {
    return { ok: false, error: `A command called “${label}” already exists.` };
  }
  database.query("INSERT INTO custom_commands (slug, label, bin, args, env_var, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(slug, label, bin, JSON.stringify(args), envVar, Date.now());
  const created = findCommand(slug, database);
  return created ? { ok: true, command: created } : { ok: false, error: "Could not save that command." };
}

/**
 * Store this agent's credential. Write-only by design: nothing reads it back out to
 * a client, `listCommands` reports only whether one is set, and it reaches the agent
 * through the process environment rather than a command line.
 */
export function setCommandToken(id: number, token: unknown, database: Database = db, secrets: SecretCodec = { sealSecret, openSecret }): { ok: true } | { ok: false; error: string } {
  const value = String(token ?? "").trim();
  if (!value) return { ok: false, error: "Paste a token to store." };
  if (value.length > TOKEN_MAX) return { ok: false, error: "That token is implausibly long." };
  if (hasControlChars(value)) return { ok: false, error: "That token contains control characters." };

  const row = database.query("SELECT env_var FROM custom_commands WHERE id = ?").get(id) as { env_var: string | null } | null;
  if (!row) return { ok: false, error: "That command is no longer registered." };
  if (!row.env_var) {
    return { ok: false, error: "Give this command an env var name first — the token has to be delivered as something its CLI reads." };
  }
  database.query("UPDATE custom_commands SET token = ? WHERE id = ?").run(secrets.sealSecret(value, `custom-command:${id}:${row.env_var}`), id);
  return { ok: true };
}

export function clearCommandToken(id: number, database: Database = db): boolean {
  return database.query("UPDATE custom_commands SET token = NULL WHERE id = ?").run(id).changes > 0;
}

/**
 * The environment a Command's session should start with. Returns an empty object
 * unless both an env var name and a token are set, so a launch never invents a
 * variable or exports an empty credential.
 */
export function commandEnv(slug: string, database: Database = db, secrets: SecretCodec = { sealSecret, openSecret }): Record<string, string> {
  const command = database.query("SELECT id, env_var, token FROM custom_commands WHERE slug = ?").get(slug) as
    { id: number; env_var: string | null; token: string | null } | null;
  if (!command?.env_var || !command.token) return {};
  if (!ENV_VAR_RE.test(command.env_var)) return {}; // hand-edited row; refuse rather than export junk
  return { [command.env_var]: secrets.openSecret(command.token, `custom-command:${command.id}:${command.env_var}`) };
}

/**
 * Removing a definition never touches Sessions already running under it — their rows
 * keep `cmd:<slug>` and the lifecycle falls back to screen-descendant liveness.
 */
export function deleteCommand(id: number, database: Database = db): boolean {
  return database.query("DELETE FROM custom_commands WHERE id = ?").run(id).changes > 0;
}
