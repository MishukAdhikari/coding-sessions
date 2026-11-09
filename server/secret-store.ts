/**
 * Secrets — named values (API tokens, keys) every managed session receives in its
 * environment, from the app's own store or from an external secret manager.
 *
 * Three promises hold everywhere in this file:
 *  - Write-only. No route returns a value; views carry names and timestamps only.
 *  - Sealed or nothing. Values, source credentials and source snapshots are AES-GCM
 *    sealed with the token encryption key; without that key nothing is written.
 *  - Environment, never argv. Values reach the agent through its holder's
 *    environment (see mux.spawn), because /proc/<pid>/cmdline is world-readable.
 *
 * External sources: Bitwarden Secrets Manager (through the `bws` CLI, which does the
 * client-side decryption), Infisical (machine identity, universal auth) and
 * HashiCorp Vault / OpenBao (KV v2). A source is fetched at launch when its last
 * sync is older than SNAPSHOT_FRESH_MS; if the fetch fails, the last good snapshot
 * is used and the error is kept for the Secrets sheet to show.
 */
import type { Database } from "bun:sqlite";
import { db } from "./db";
import { childEnvironment } from "./child-env";
import { DestinationError, networkPolicy, readBounded, safeFetch, validateServerUrl } from "./connector-net";
import { isSealedSecret, openSecret, sealSecret, type SecretCodec } from "./secrets";

export type SourceKind = "bitwarden" | "infisical" | "vault";
export const SOURCE_KINDS: readonly SourceKind[] = ["bitwarden", "infisical", "vault"];

export interface SecretView { name: string; updatedAt: number }
export interface SourceView {
  id: number;
  kind: SourceKind;
  label: string;
  /** Non-secret settings only: URLs, ids, paths. The credential is never included. */
  config: Record<string, string>;
  /** Names the last successful sync delivered. */
  names: string[];
  lastSyncAt: number | null;
  lastError: string | null;
}

export class SecretStoreError extends Error {
  constructor(message: string, readonly status = 422) { super(message); this.name = "SecretStoreError"; }
}

/** What a CLI would actually read; same rule as a Command's token env var. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const VALUE_MAX = 32 * 1024;
const LABEL_MAX = 40;
const SOURCES_MAX = 10;
const SECRETS_MAX = 200;
const RESPONSE_MAX = 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
export const SNAPSHOT_FRESH_MS = 5 * 60_000;

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

export function checkName(raw: unknown): string {
  const name = String(raw ?? "").trim();
  if (!SECRET_NAME_RE.test(name)) throw new SecretStoreError("Name it like an env var: capitals, digits and underscores, starting with a letter (e.g. OPENAI_API_KEY).");
  if (reservedName(name)) throw new SecretStoreError(`${name} is used by the server or the session itself, so it cannot be stored as a secret.`);
  return name;
}

const usableValue = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= VALUE_MAX && !value.includes("\u0000");

/** Keep only entries a session can receive; external managers may hold anything. */
function usableEntries(entries: Iterable<[unknown, unknown]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof key === "string" && SECRET_NAME_RE.test(key) && !reservedName(key) && usableValue(value)) out[key] = value;
  }
  return out;
}

/* ---------- external sources ---------- */

type Config = Record<string, string>;
type Run = (argv: string[], env: Record<string, string>) => Promise<{ code: number; out: string }>;
export interface SourceDependencies {
  /** Vetted transport for operator-entered URLs (role "oauth" permits a query string). */
  fetch: typeof fetch;
  runBws: Run;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PATH_RE = /^[A-Za-z0-9._\-/]{1,256}$/;

function field(input: Record<string, unknown>, name: string, fallback = ""): string {
  const value = input[name];
  return typeof value === "string" ? value.trim() : fallback;
}
function baseUrl(value: string): string {
  try { return validateServerUrl(value, networkPolicy()).toString().replace(/\/+$/, ""); }
  catch (error) { throw new SecretStoreError(error instanceof DestinationError ? error.message : "Enter an https:// URL."); }
}
function kvPath(value: string, what: string): string {
  const path = value.replace(/^\/+|\/+$/g, "");
  if (!PATH_RE.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) throw new SecretStoreError(`Enter the ${what} as plain path segments, e.g. apps/sessions.`);
  return path;
}

/** Validate operator input into the non-secret config each source stores. */
export function validateSourceConfig(kind: SourceKind, input: Record<string, unknown>): Config {
  if (kind === "bitwarden") {
    const projectId = field(input, "projectId");
    if (projectId && !UUID_RE.test(projectId)) throw new SecretStoreError("The Bitwarden project id is a UUID; copy it from the project's page.");
    const serverUrl = field(input, "serverUrl");
    return { ...(projectId ? { projectId } : {}), ...(serverUrl ? { serverUrl: baseUrl(serverUrl) } : {}) };
  }
  if (kind === "infisical") {
    const clientId = field(input, "clientId");
    const projectId = field(input, "projectId");
    const environment = field(input, "environment", "prod") || "prod";
    if (!SLUG_RE.test(clientId)) throw new SecretStoreError("Enter the machine identity's client id.");
    if (!SLUG_RE.test(projectId)) throw new SecretStoreError("Enter the Infisical project id.");
    if (!SLUG_RE.test(environment)) throw new SecretStoreError("Enter the environment slug, e.g. prod.");
    const secretPath = field(input, "secretPath", "/") || "/";
    return {
      siteUrl: baseUrl(field(input, "siteUrl") || "https://app.infisical.com"),
      clientId, projectId, environment,
      secretPath: secretPath === "/" ? "/" : `/${kvPath(secretPath, "secret path")}`,
    };
  }
  const namespace = field(input, "namespace");
  if (namespace && !PATH_RE.test(namespace)) throw new SecretStoreError("Enter the namespace as plain path segments.");
  return {
    address: baseUrl(field(input, "address")),
    mount: kvPath(field(input, "mount", "secret") || "secret", "KV mount"),
    path: kvPath(field(input, "path"), "secret path"),
    ...(namespace ? { namespace } : {}),
  };
}

async function readJson(response: Response): Promise<unknown> {
  try { return JSON.parse(await readBounded(response, RESPONSE_MAX)); } catch { return null; }
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Fixed wording per status: an upstream error body may echo the credential. */
function httpFailure(service: string, status: number): SecretStoreError {
  if (status === 401 || status === 403) return new SecretStoreError(`${service} refused the credential. Check it and its access to these secrets.`);
  if (status === 404) return new SecretStoreError(`${service} found nothing at that project or path.`);
  return new SecretStoreError(`${service} answered with HTTP ${status}.`);
}

export async function fetchSource(kind: SourceKind, config: Config, credential: string, deps: SourceDependencies): Promise<Record<string, string>> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  if (kind === "bitwarden") {
    const argv = ["bws", "secret", "list", ...(config.projectId ? [config.projectId] : []), "--output", "json",
      ...(config.serverUrl ? ["--server-url", config.serverUrl] : [])];
    const result = await deps.runBws(argv, { BWS_ACCESS_TOKEN: credential });
    if (result.code === 127) throw new SecretStoreError("The Bitwarden Secrets Manager CLI (bws) is not installed on the server.");
    if (result.code !== 0) throw new SecretStoreError("bws could not list the secrets. Check the access token and the project id.");
    let list: unknown;
    try { list = JSON.parse(result.out); } catch { throw new SecretStoreError("bws returned output this app could not read."); }
    if (!Array.isArray(list)) throw new SecretStoreError("bws returned output this app could not read.");
    return usableEntries(list.map(item => [record(item).key, record(item).value]));
  }
  if (kind === "infisical") {
    const login = await deps.fetch(`${config.siteUrl}/api/v1/auth/universal-auth/login`, {
      method: "POST", signal, headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ clientId: config.clientId, clientSecret: credential }),
    });
    if (!login.ok) throw httpFailure("Infisical", login.status);
    const accessToken = record(await readJson(login)).accessToken;
    if (typeof accessToken !== "string" || !accessToken) throw new SecretStoreError("Infisical did not return an access token.");
    const query = new URLSearchParams({
      projectId: config.projectId!, environment: config.environment!, secretPath: config.secretPath!,
      viewSecretValue: "true", expandSecretReferences: "true", includeImports: "true",
    });
    const list = await deps.fetch(`${config.siteUrl}/api/v4/secrets?${query}`, { signal, headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
    if (!list.ok) throw httpFailure("Infisical", list.status);
    const body = record(await readJson(list));
    const pairs = (items: unknown): Array<[unknown, unknown]> =>
      Array.isArray(items) ? items.map(item => [record(item).secretKey, record(item).secretValue]) : [];
    // Imported secrets first, so the path's own secrets win on a clash — Infisical's own rule.
    const imported = Array.isArray(body.imports) ? body.imports.flatMap(entry => pairs(record(entry).secrets)) : [];
    if (!Array.isArray(body.secrets)) throw new SecretStoreError("Infisical returned a response this app could not read.");
    return usableEntries([...imported, ...pairs(body.secrets)]);
  }
  const response = await deps.fetch(`${config.address}/v1/${config.mount}/data/${config.path}`, {
    signal, headers: { "x-vault-token": credential, accept: "application/json", ...(config.namespace ? { "x-vault-namespace": config.namespace } : {}) },
  });
  if (!response.ok) throw httpFailure("Vault", response.status);
  const data = record(record(record(await readJson(response)).data).data);
  return usableEntries(Object.entries(data));
}

async function runBws(argv: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  try {
    const child = Bun.spawn(argv, { env: childEnvironment(env), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(9), FETCH_TIMEOUT_MS);
    try { return { out: await new Response(child.stdout).text(), code: await child.exited }; }
    finally { clearTimeout(timer); }
  } catch { return { code: 127, out: "" }; }
}

/* ---------- the store ---------- */

interface SourceRow {
  id: number; kind: string; label: string; config: string; credential: string; snapshot: string | null;
  names: string; last_sync_at: number | null; last_error: string | null; created_at: number;
}

export interface SecretStoreDependencies {
  database: Database;
  codec: SecretCodec;
  sources: SourceDependencies;
  now: () => number;
}

const parse = <T>(text: string | null, fallback: T): T => { try { return text === null ? fallback : JSON.parse(text) as T; } catch { return fallback; } };
const isKind = (value: unknown): value is SourceKind => SOURCE_KINDS.includes(value as SourceKind);

export function createSecretStore(deps: SecretStoreDependencies) {
  const { database, codec } = deps;

  function seal(value: string, context: string): string {
    const sealed = codec.sealSecret(value, context);
    // Without a key the codec passes the value through unchanged; refuse rather than store plaintext.
    if (!isSealedSecret(sealed)) throw new SecretStoreError("Secrets need the token encryption key, which this server does not have configured. Nothing was saved.", 503);
    return sealed;
  }
  const secretContext = (name: string) => `secret:${name}`;
  const credentialContext = (row: Pick<SourceRow, "id" | "kind">) => `secret-source:${row.id}:${row.kind}`;
  const snapshotContext = (row: Pick<SourceRow, "id" | "kind">) => `secret-source-snapshot:${row.id}:${row.kind}`;

  function sourceRow(id: number): SourceRow {
    const row = database.query("SELECT * FROM secret_sources WHERE id = ?").get(id) as SourceRow | null;
    if (!row || !isKind(row.kind)) throw new SecretStoreError("That source is no longer configured.", 404);
    return row;
  }

  function view(row: SourceRow): SourceView {
    return {
      id: row.id, kind: row.kind as SourceKind, label: row.label, config: parse<Config>(row.config, {}),
      names: parse<string[]>(row.names, []), lastSyncAt: row.last_sync_at, lastError: row.last_error,
    };
  }

  /** Fetch one source now, keeping a sealed snapshot of what it returned. */
  async function sync(row: SourceRow): Promise<Record<string, string>> {
    try {
      const values = await fetchSource(row.kind as SourceKind, parse<Config>(row.config, {}), codec.openSecret(row.credential, credentialContext(row)), deps.sources);
      database.query("UPDATE secret_sources SET snapshot = ?, names = ?, last_sync_at = ?, last_error = NULL WHERE id = ?")
        .run(seal(JSON.stringify(values), snapshotContext(row)), JSON.stringify(Object.keys(values).sort()), deps.now(), row.id);
      return values;
    } catch (error) {
      const message = error instanceof SecretStoreError ? error.message
        : error instanceof DestinationError ? error.message
        : (error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError" ? "The source did not answer in time."
        : "The source could not be reached.";
      database.query("UPDATE secret_sources SET last_error = ? WHERE id = ?").run(message, row.id);
      throw new SecretStoreError(message, 502);
    }
  }

  function snapshot(row: SourceRow): Record<string, string> {
    if (!row.snapshot) return {};
    try { return usableEntries(Object.entries(parse<Record<string, unknown>>(codec.openSecret(row.snapshot, snapshotContext(row)), {}))); }
    catch { return {}; }
  }

  return {
    list(): { secrets: SecretView[]; sources: SourceView[] } {
      const secrets = (database.query("SELECT name, updated_at FROM secrets ORDER BY name").all() as Array<{ name: string; updated_at: number }>)
        .map(row => ({ name: row.name, updatedAt: row.updated_at }));
      const sources = (database.query("SELECT * FROM secret_sources ORDER BY id").all() as SourceRow[]).filter(row => isKind(row.kind)).map(view);
      return { secrets, sources };
    },

    /** Create or replace. The value never comes back out through any route. */
    set(rawName: unknown, value: unknown): SecretView {
      const name = checkName(rawName);
      if (!usableValue(value) || !value.trim()) throw new SecretStoreError("Paste a value of up to 32 KB.");
      const exists = database.query("SELECT 1 FROM secrets WHERE name = ?").get(name);
      if (!exists && (database.query("SELECT COUNT(*) AS n FROM secrets").get() as { n: number }).n >= SECRETS_MAX) {
        throw new SecretStoreError(`Keep it under ${SECRETS_MAX} secrets.`);
      }
      const updatedAt = deps.now();
      database.query("INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .run(name, seal(value, secretContext(name)), updatedAt);
      return { name, updatedAt };
    },

    /**
     * Where a session's value for this name comes from, by the same precedence as
     * sessionEnv: the app's own store wins, else the last source that delivers it.
     * Names and timestamps only.
     */
    describe(rawName: unknown): { name: string; set: boolean; updatedAt: number | null; source: string | null } {
      const name = String(rawName ?? "").trim();
      const own = database.query("SELECT updated_at FROM secrets WHERE name = ?").get(name) as { updated_at: number } | null;
      if (own) return { name, set: true, updatedAt: own.updated_at, source: "Coding Sessions" };
      const rows = (database.query("SELECT * FROM secret_sources ORDER BY id DESC").all() as SourceRow[]).filter(row => isKind(row.kind));
      const from = rows.find(row => parse<string[]>(row.names, []).includes(name));
      return from ? { name, set: true, updatedAt: from.last_sync_at, source: from.label } : { name, set: false, updatedAt: null, source: null };
    },

    remove(rawName: unknown): boolean {
      const name = String(rawName ?? "");
      return database.query("DELETE FROM secrets WHERE name = ?").run(name).changes > 0;
    },

    /** Saves the source only after a first successful sync, so a typo never lingers as a broken entry. */
    async addSource(input: Record<string, unknown>): Promise<SourceView> {
      const kind = input.kind;
      if (!isKind(kind)) throw new SecretStoreError("Choose Bitwarden, Infisical or Vault.");
      const label = String(input.label ?? "").trim() || { bitwarden: "Bitwarden", infisical: "Infisical", vault: "Vault" }[kind];
      if (label.length > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(label)) throw new SecretStoreError(`Keep the name under ${LABEL_MAX} characters.`);
      const config = validateSourceConfig(kind, record(input.config));
      const credential = typeof input.credential === "string" ? input.credential.trim() : "";
      if (!/^[\x21-\x7e]{8,4096}$/.test(credential)) throw new SecretStoreError("Paste the credential as a single line of visible characters.");
      if ((database.query("SELECT COUNT(*) AS n FROM secret_sources").get() as { n: number }).n >= SOURCES_MAX) throw new SecretStoreError(`Keep it under ${SOURCES_MAX} sources.`);

      // Prove the credential before keeping it: fetch first, then store.
      let values: Record<string, string>;
      try { values = await fetchSource(kind, config, credential, deps.sources); }
      catch (error) {
        if (error instanceof SecretStoreError) throw error;
        if (error instanceof DestinationError) throw new SecretStoreError(`${error.message} Nothing was saved.`, 502);
        throw new SecretStoreError((error as Error)?.name === "TimeoutError" ? "The source did not answer in time. Nothing was saved." : "The source could not be reached. Nothing was saved.", 502);
      }
      const id = database.transaction(() => {
        const created = database.query("INSERT INTO secret_sources (kind, label, config, credential, created_at) VALUES (?, ?, ?, '', ?) RETURNING id")
          .get(kind, label, JSON.stringify(config), deps.now()) as { id: number };
        const row = { id: created.id, kind };
        database.query("UPDATE secret_sources SET credential = ?, snapshot = ?, names = ?, last_sync_at = ? WHERE id = ?")
          .run(seal(credential, credentialContext(row)), seal(JSON.stringify(values), snapshotContext(row)), JSON.stringify(Object.keys(values).sort()), deps.now(), row.id);
        return created.id;
      })();
      return view(sourceRow(id));
    },

    async syncSource(id: number): Promise<SourceView> {
      await sync(sourceRow(id));
      return view(sourceRow(id));
    },

    removeSource(id: number): boolean {
      return database.query("DELETE FROM secret_sources WHERE id = ?").run(id).changes > 0;
    },

    /**
     * The environment a new session starts with. Sources apply in the order they were
     * added, then the app's own secrets on top, so a value typed here always wins.
     * Callers spread provider credentials and session plumbing after this, so those
     * always win over anything stored. A source that cannot be fetched falls back to
     * its last snapshot; one that cannot be opened at all is skipped, never fatal.
     */
    async sessionEnv(options: { fetch?: boolean } = {}): Promise<Record<string, string>> {
      const env: Record<string, string> = {};
      const rows = (database.query("SELECT * FROM secret_sources ORDER BY id").all() as SourceRow[]).filter(row => isKind(row.kind));
      const fetched = await Promise.all(rows.map(async row => {
        if (options.fetch === false) return snapshot(row);
        if (row.last_sync_at !== null && deps.now() - row.last_sync_at < SNAPSHOT_FRESH_MS) return snapshot(row);
        try { return await sync(row); } catch { return snapshot(row); }
      }));
      for (const values of fetched) Object.assign(env, values);
      for (const row of database.query("SELECT name, value FROM secrets ORDER BY name").all() as Array<{ name: string; value: string }>) {
        if (!SECRET_NAME_RE.test(row.name) || reservedName(row.name)) continue;
        try { env[row.name] = codec.openSecret(row.value, secretContext(row.name)); } catch {}
      }
      return env;
    },
  };
}

export type SecretStore = ReturnType<typeof createSecretStore>;

let defaultStore: SecretStore | undefined;
/** Lazy, so importing this module never reads the key file or opens the database early. */
export function secretStore(): SecretStore {
  return defaultStore ??= createSecretStore({
    database: db,
    codec: { sealSecret, openSecret },
    sources: { fetch: safeFetch({ policy: networkPolicy(), role: "oauth" }), runBws },
    now: Date.now,
  });
}

/** Never lets a secrets problem block a launch: the session simply starts without them. */
export async function sessionSecretEnv(): Promise<Record<string, string>> {
  try { return await secretStore().sessionEnv(); } catch { return {}; }
}
