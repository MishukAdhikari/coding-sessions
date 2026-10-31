import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import { createSecretCodec, loadTokenKey, type SecretCodec } from "./secrets";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { addressAllowed, DestinationError, networkPolicy, safeFetch, validateServerUrl, type NetworkPolicy, type Resolver } from "./connector-net";
import { UpstreamClient, UpstreamError, UpstreamRpcError, type UpstreamTool } from "./connector-upstream";

type Environment = Record<string, string | undefined>;
export type Provider = "claude" | "codex" | "command-code";
const PROVIDERS: readonly Provider[] = ["claude", "codex", "command-code"];
export const CONNECTOR_TOKEN = /^csconn_[A-Za-z0-9_-]{43}$/;

export interface LaunchIdentity { launch_id: string; session_id: string; name: string; agent: Provider }
export type ConnectorState = "disabled" | "needs_url" | "not_checked" | "connected" | "auth_failed" | "forbidden" | "blocked" | "unavailable";
/** Upstream annotations, shown to the operator as the server's own claims. Never used to grant or to label tools for agents. */
export interface ToolHints { readOnly?: boolean; destructive?: boolean; idempotent?: boolean; openWorld?: boolean }
export interface ConnectorView {
  id: string; name: string; namespace: string; url: string | null; host: string | null;
  enabled: boolean; state: ConnectorState;
  credential: { set: boolean; set_at: number | null };
  server: { name: string; version: string | null } | null;
  checked_at: number | null; last_ok_at: number | null;
  /** Local explanation when a destination was refused (never upstream text). */
  check_detail: string | null;
  /** exposed is null when the name would collide with another tool's; such a tool cannot be granted. */
  tools: Array<{ name: string; exposed: string | null; title: string | null; description: string | null; hints: ToolHints; granted: boolean; offered: boolean }>;
  discovered_count: number; granted_tools: string[];
  default_providers: Provider[];
  launches: Array<LaunchIdentity & { granted: boolean }>;
}
export interface ExposedTool { name: string; title?: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, boolean> }

export class ConnectorError extends Error {
  constructor(public readonly code: "unauthorized" | "invalid_request" | "not_found" | "denied" | "unavailable" | "rate_limited" | "storage", message: string) {
    super(message); this.name = "ConnectorError";
  }
}
const invalid = (message: string): never => { throw new ConnectorError("invalid_request", message); };
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const SEALED = "xcs:secret:v1:";
const AUDIT_RETENTION_MS = 30 * 86400_000;
const CATALOG_TTL_MS = 15 * 60_000;
const MAX_ARGS_BYTES = 64 * 1024;
const PER_LAUNCH = 4;
const PER_CONNECTOR = 8;

interface Row {
  id: string; name: string; slug: string; url: string; enabled: number; credential: string | null; credential_set_at: number | null;
  granted_tools: string; default_providers: string; catalog: string | null; catalog_at: number | null; catalog_stale: number;
  server_info: string | null; check_status: string | null; check_detail: string | null; check_at: number | null; check_ok_at: number | null; created_at: number;
}
/** Exposed names must fit common client limits: letters, digits, _ and -, at most 64 characters. */
const EXPOSED = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * <namespace>__<tool>, or a deterministic bounded alias when the server's name has other
 * characters or would be too long: the cleaned name, cut to fit, plus 8 hex of its hash.
 */
export function exposedName(slug: string, tool: string): string {
  const plain = `${slug}__${tool}`;
  if (EXPOSED.test(plain)) return plain;
  const digest = createHash("sha256").update(tool).digest("hex").slice(0, 8);
  const budget = 64 - slug.length - 2 - 9;
  return `${slug}__${tool.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, budget)}_${digest}`;
}
/**
 * Exposed names for one connector's tools. An alias can coincide with another tool's literal
 * name (e.g. "a.b" and "a_b_<hash>"); any name produced by more than one tool is withheld from
 * all of them, so a call can never reach a different tool than the one the operator granted.
 */
export function exposures(slug: string, names: Iterable<string>): Map<string, string | null> {
  const unique = [...new Set(names)];
  const owners = new Map<string, number>();
  for (const name of unique) { const exposed = exposedName(slug, name); owners.set(exposed, (owners.get(exposed) ?? 0) + 1); }
  return new Map(unique.map(name => { const exposed = exposedName(slug, name); return [name, owners.get(exposed) === 1 ? exposed : null]; }));
}
interface Active { connectorId: string; launchId: string; tool: string; abort: AbortController }
export interface ConnectorDependencies {
  database: Database;
  isLive(identity: LaunchIdentity): Promise<boolean>;
  /** Defaults to a codec built from the configured key, refusing to work without one. */
  codec?: () => SecretCodec;
  fetch?: typeof fetch;
  /** Test seam for DNS; production uses the system resolver through the vetted lookup. */
  resolver?: Resolver;
  now?: () => number;
  env?: Environment;
}
const json = <T>(text: string | null, fallback: T): T => { try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; } };

/** Required key, never the plaintext fallback the general codec permits. */
export function connectorCodec(env: Environment = process.env): SecretCodec {
  let key: Uint8Array | null;
  try { key = loadTokenKey(env); } catch { key = null; }
  if (!key) throw new ConnectorError("storage", "Connector credentials need this server's token-encryption key (systemd credential token-encryption-key or CS_TOKEN_KEY_FILE). Nothing was saved.");
  return createSecretCodec(key);
}

const TYPES: Record<string, (value: unknown) => boolean> = {
  string: v => typeof v === "string", number: v => typeof v === "number" && Number.isFinite(v),
  integer: v => typeof v === "number" && Number.isSafeInteger(v), boolean: v => typeof v === "boolean",
  array: Array.isArray, object: v => !!v && typeof v === "object" && !Array.isArray(v), null: v => v === null,
};
/**
 * Top-level check against the advertised inputSchema: object shape, required and unknown
 * keys, primitive types and enums. Nested constraints are left to the upstream, which
 * validates its own arguments; this exists so a hidden extra field cannot slip through.
 */
export function validateArguments(schema: Record<string, unknown>, args: unknown): string | null {
  if (!TYPES.object!(args)) return "arguments must be an object";
  if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGS_BYTES) return "arguments exceed 64 KiB";
  if (schema.type !== undefined && schema.type !== "object") return "unsupported input schema";
  const values = args as Record<string, unknown>;
  const properties = TYPES.object!(schema.properties) ? schema.properties as Record<string, Record<string, unknown>> : {};
  for (const name of Array.isArray(schema.required) ? schema.required : []) {
    if (typeof name === "string" && !Object.hasOwn(values, name)) return `missing required argument ${name}`;
  }
  for (const [name, value] of Object.entries(values)) {
    const property = properties[name];
    if (!property) {
      if (schema.additionalProperties === false) return `unknown argument ${name}`;
      continue;
    }
    if (!TYPES.object!(property)) continue;
    const types = typeof property.type === "string" ? [property.type] : Array.isArray(property.type) ? property.type : [];
    if (types.length && !types.some(type => typeof type === "string" && TYPES[type]?.(value))) return `argument ${name} has the wrong type`;
    if (Array.isArray(property.enum) && !property.enum.some(option => isDeepStrictEqual(option, value))) return `argument ${name} is not an allowed value`;
    if (property.const !== undefined && !isDeepStrictEqual(property.const, value)) return `argument ${name} is not an allowed value`;
  }
  return null;
}

/**
 * Outbound MCP connectors: operator-added servers, a server-held optional bearer token,
 * explicit tool, provider and launch grants, and a per-launch capability checked on every
 * call. The capability is a separate audience from the communicator mailbox.
 */
export class Connectors {
  private readonly now: () => number;
  private readonly env: Environment;
  private readonly policy: NetworkPolicy;
  private readonly clients = new Map<string, UpstreamClient>();
  private readonly active = new Set<Active>();
  /** Latest-wins settings checks; replacing, disabling or removing aborts the one running. */
  private readonly checks = new Map<string, AbortController>();
  constructor(private readonly deps: ConnectorDependencies) {
    this.now = deps.now ?? Date.now;
    this.env = deps.env ?? process.env;
    this.policy = networkPolicy(this.env);
  }
  private get db() { return this.deps.database; }
  private codec(): SecretCodec { return (this.deps.codec ?? (() => connectorCodec(this.env)))(); }

  private row(id: string): Row | null { return this.db.query("SELECT * FROM mcp_connectors WHERE id=?").get(id) as Row | null; }
  private must(id: unknown): Row {
    const row = typeof id === "string" ? this.row(id) : null;
    if (!row) throw new ConnectorError("not_found", "That connector does not exist.");
    return row;
  }
  private launch(launchId: string): LaunchIdentity | null {
    const row = this.db.query("SELECT launch_id, screen, name, provider FROM launches WHERE launch_id=? AND phase != 'failed'")
      .get(launchId) as { launch_id: string; screen: string; name: string; provider: string } | null;
    if (!row || !PROVIDERS.includes(row.provider as Provider)) return null;
    return { launch_id: row.launch_id, session_id: `m:${row.screen}`, name: row.name, agent: row.provider as Provider };
  }
  /** The stored URL, revalidated against the current policy on every use. */
  private endpoint(row: Row): URL | null {
    if (!row.url) return null;
    try { return validateServerUrl(row.url, this.policy); } catch { return null; }
  }

  private client(row: Row): UpstreamClient {
    let client = this.clients.get(row.id);
    if (!client) {
      const url = this.endpoint(row);
      if (!url) throw new ConnectorError("unavailable", "This connector's URL is missing or no longer allowed.");
      const id = row.id;
      // Bound to the exact URL and token revision this client was made for: if either changes,
      // every later request from it (initialize, notifications, retries) fails before sending.
      const bound = { url: row.url, credential: row.credential };
      client = new UpstreamClient({
        url, now: this.now,
        fetch: this.deps.fetch ?? safeFetch({ policy: this.policy, resolver: this.deps.resolver, env: this.env }),
        credential: () => this.credential(id, bound),
        onToolsChanged: () => { this.db.query("UPDATE mcp_connectors SET catalog_stale=1 WHERE id=? AND url=?").run(id, bound.url); },
      });
      this.clients.set(id, client);
    }
    return client;
  }
  /** The token is bound to the connector and its origin; it is opened only for a request and never returned. */
  private context(id: string, url: string): string { return `mcp-connector:${id}:${new URL(url).origin}`; }
  private credential(id: string, bound: { url: string; credential: string | null }): string | null {
    const row = this.row(id);
    if (!row || !row.enabled || row.url !== bound.url || row.credential !== bound.credential) {
      throw new ConnectorError("unavailable", "This connector changed; the request was not sent.");
    }
    if (!row.credential) return null;
    if (!row.credential.startsWith(SEALED) || !row.url) throw new ConnectorError("unavailable", "This connector's token cannot be used.");
    try { return this.codec().openSecret(row.credential, this.context(id, row.url)); }
    catch (error) { throw error instanceof ConnectorError ? error : new ConnectorError("storage", "The connector token cannot be opened with this server's key."); }
  }
  private seal(id: string, url: string, token: unknown): string {
    if (typeof token !== "string" || !/^[\x21-\x7e]{8,4096}$/.test(token.trim())) return invalid("Paste the token as a single line of 8–4096 visible characters, without spaces.");
    const sealed = this.codec().sealSecret(token.trim(), this.context(id, url));
    if (!sealed.startsWith(SEALED)) throw new ConnectorError("storage", "Connector tokens must be encrypted. Nothing was saved.");
    return sealed;
  }
  private invalidate(id: string): void {
    this.checks.get(id)?.abort(); this.checks.delete(id);
    this.clients.get(id)?.close(); this.clients.delete(id);
    // Results computed under the previous settings must not be delivered under the new ones.
    this.abortWhere(entry => entry.connectorId === id);
  }
  private abortWhere(match: (active: Active) => boolean): void {
    for (const entry of this.active) if (match(entry)) entry.abort.abort();
  }

  /* ---------- operator surface (browser session only; see connectors-route.ts) ---------- */

  private name(value: unknown): string {
    const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) return invalid("Give the connector a name of 1–60 characters.");
    return name;
  }
  /** A permanent tool prefix derived once from the first name; renaming never changes it. */
  private slug(name: string): string {
    const base = (name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "s$1") || "mcp").slice(0, 20).replace(/_+$/, "");
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base.slice(0, 17)}_${n}`;
      if (!this.db.query("SELECT 1 FROM mcp_connectors WHERE slug=?").get(candidate)) return candidate;
    }
  }
  private async vetDestination(url: URL): Promise<void> {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) return; // literals were checked by validateServerUrl
    let addresses: Array<{ address: string; family: number }>;
    try { addresses = this.deps.resolver ? await this.deps.resolver(host) : await lookup(host, { all: true, verbatim: true }); }
    catch { return invalid("That host name could not be resolved."); }
    if (!addresses.length || addresses.some(entry => !addressAllowed(entry.address, this.policy))) {
      return invalid("That host resolves to a private, local or reserved address, so it cannot be used.");
    }
  }
  private url(value: unknown): URL {
    try { return validateServerUrl(value, this.policy); }
    catch (error) { return invalid(error instanceof DestinationError ? error.message : "That URL cannot be used."); }
  }

  /** Adds a disabled-by-grant connector: nothing is granted to any tool, agent or session. */
  async add(input: { name?: unknown; url?: unknown; token?: unknown }): Promise<ConnectorView> {
    const name = this.name(input.name);
    const url = this.url(input.url);
    // Resolution is checked again, authoritatively, on every connection.
    await this.vetDestination(url);
    const id = randomUUID();
    const hasToken = typeof input.token === "string" && input.token.trim() !== "";
    const sealed = hasToken ? this.seal(id, url.href, input.token) : null;
    this.db.query(`INSERT INTO mcp_connectors (id,name,slug,url,enabled,credential,credential_set_at,created_at) VALUES (?,?,?,?,1,?,?,?)`)
      .run(id, name, this.slug(name), url.href, sealed, sealed ? this.now() : null, this.now());
    return this.view(id);
  }

  rename(id: string, value: unknown): ConnectorView {
    this.must(id);
    this.db.query("UPDATE mcp_connectors SET name=? WHERE id=?").run(this.name(value), id);
    return this.view(id);
  }

  /**
   * A new URL may be a different service or account, even on the same origin. Discovery,
   * reported server info, status, tool grants and the token are all cleared; the operator
   * re-enters a token deliberately. Agent and session grants stay (they grant nothing alone).
   */
  async setUrl(id: string, value: unknown): Promise<ConnectorView> {
    const before = this.must(id);
    const url = this.url(value);
    if (before.url === url.href) return this.view(id);
    await this.vetDestination(url);
    // The row may have changed while DNS was resolving; apply only to the state that was checked.
    const changed = this.db.query(`UPDATE mcp_connectors SET url=?,credential=NULL,credential_set_at=NULL,catalog=NULL,catalog_at=NULL,catalog_stale=0,
      server_info=NULL,check_status=NULL,check_detail=NULL,check_at=NULL,check_ok_at=NULL,granted_tools='[]' WHERE id=? AND url=? AND credential IS ?`)
      .run(url.href, id, before.url, before.credential);
    if (!changed.changes) throw new ConnectorError("invalid_request", "This connector changed while the URL was being checked. Review it and try again.");
    this.invalidate(id);
    return this.view(id);
  }

  /** Set, replace (value) or remove (null/empty) the bearer token. */
  setCredential(id: string, value: unknown): ConnectorView {
    const row = this.must(id);
    const clear = value === null || (typeof value === "string" && value.trim() === "");
    if (!clear && !row.url) return invalid("Set the server URL before adding a token.");
    const sealed = clear ? null : this.seal(id, row.url, value);
    this.db.query(`UPDATE mcp_connectors SET credential=?,credential_set_at=?,server_info=NULL,check_status=NULL,check_detail=NULL,check_at=NULL,check_ok_at=NULL,catalog_stale=1 WHERE id=?`)
      .run(sealed, sealed ? this.now() : null, id);
    this.invalidate(id);
    return this.view(id);
  }

  setEnabled(id: string, enabled: boolean): ConnectorView {
    this.must(id);
    this.db.query("UPDATE mcp_connectors SET enabled=? WHERE id=?").run(enabled ? 1 : 0, id);
    if (!enabled) this.invalidate(id);
    return this.view(id);
  }

  /** Removes the local token and every grant immediately. Upstream revocation is the operator's step. */
  remove(id: string): void {
    this.must(id);
    this.db.query("DELETE FROM mcp_connectors WHERE id=?").run(id);
    this.invalidate(id);
  }

  /** Grants exactly the listed tools. Each must be offered in the latest discovery and fit an exposable name. */
  setTools(id: string, tools: unknown): ConnectorView {
    const row = this.must(id);
    if (!Array.isArray(tools) || tools.some(tool => typeof tool !== "string")) return invalid("tools must be a list of tool names.");
    const wanted = [...new Set(tools as string[])];
    const catalog = json<UpstreamTool[]>(row.catalog, []);
    const previous = json<string[]>(row.granted_tools, []);
    for (const tool of wanted) {
      // A tool granted earlier may stay granted while the server stops offering it; it is still refused at call time.
      if (previous.includes(tool) && !catalog.some(entry => entry.name === tool)) continue;
      if (!catalog.some(entry => entry.name === tool)) return invalid(`${tool} is not offered by this server. Test the connection to refresh its tools.`);
      if (!exposures(row.slug, catalog.map(entry => entry.name)).get(tool)) return invalid(`${tool} cannot be granted: its agent-facing name would collide with another tool on this server.`);
    }
    this.db.query("UPDATE mcp_connectors SET granted_tools=? WHERE id=?").run(JSON.stringify(wanted.sort()), id);
    this.abortWhere(entry => entry.connectorId === id && !wanted.includes(entry.tool));
    return this.view(id);
  }

  setDefaultProviders(id: string, providers: unknown): ConnectorView {
    this.must(id);
    if (!Array.isArray(providers) || providers.some(p => !PROVIDERS.includes(p as Provider))) return invalid("providers must be claude, codex or command-code.");
    this.db.query("UPDATE mcp_connectors SET default_providers=? WHERE id=?").run(JSON.stringify([...new Set(providers)].sort()), id);
    return this.view(id);
  }

  setLaunchGrant(id: string, launchId: unknown, granted: boolean): ConnectorView {
    this.must(id);
    if (typeof launchId !== "string" || !this.capability(launchId)) return invalid("That session was not started with connector access. Relaunch or resume it first.");
    if (granted) this.db.query("INSERT OR IGNORE INTO connector_launch_grants (connector_id,launch_id,granted_at) VALUES (?,?,?)").run(id, launchId, this.now());
    else {
      this.db.query("DELETE FROM connector_launch_grants WHERE connector_id=? AND launch_id=?").run(id, launchId);
      this.abortWhere(entry => entry.connectorId === id && entry.launchId === launchId);
    }
    return this.view(id);
  }

  /** A real discovery against the server: the only thing that may mark a connector connected. Grants nothing. */
  async check(id: string): Promise<ConnectorView> {
    const row = this.must(id);
    if (!row.enabled || !this.endpoint(row)) return this.view(id);
    this.checks.get(id)?.abort();
    const abort = new AbortController();
    this.checks.set(id, abort);
    const client = this.client(row);
    client.reset("settings");
    // Writes apply only if this is still the latest check for the same URL, token and state.
    const current = () => this.checks.get(id) === abort && !abort.signal.aborted;
    const guard = "WHERE id=? AND url=? AND credential IS ? AND enabled=1";
    let status = "ok";
    let blocked: string | null = null;
    try {
      const session = await client.session("settings", { timeoutMs: 20_000, signal: abort.signal });
      const tools = await client.listTools("settings", { timeoutMs: 20_000, signal: abort.signal });
      if (current()) this.db.query(`UPDATE mcp_connectors SET catalog=?,catalog_at=?,catalog_stale=0,server_info=?,check_ok_at=? ${guard}`)
        .run(JSON.stringify(tools), this.now(), session.serverInfo ? JSON.stringify(session.serverInfo) : null, this.now(), id, row.url, row.credential);
    } catch (error) {
      status = error instanceof DestinationError ? "blocked"
        : error instanceof UpstreamError ? ({ auth: "auth_failed", forbidden: "forbidden" } as Record<string, string>)[error.kind] ?? "unavailable" : "unavailable";
      blocked = error instanceof DestinationError ? error.message : null;
    }
    if (current()) {
      this.db.query(`UPDATE mcp_connectors SET check_status=?,check_detail=?,check_at=? ${guard}`).run(status, blocked, this.now(), id, row.url, row.credential);
      this.checks.delete(id);
    }
    return this.view(id);
  }

  list(): ConnectorView[] {
    return (this.db.query("SELECT id FROM mcp_connectors ORDER BY created_at").all() as Array<{ id: string }>).map(row => this.view(row.id));
  }

  view(id: string): ConnectorView {
    const row = this.must(id);
    const catalog = json<UpstreamTool[] | null>(row.catalog, null);
    const granted = json<string[]>(row.granted_tools, []);
    const exposed = exposures(row.slug, [...(catalog ?? []).map(tool => tool.name), ...granted]);
    const tools = (catalog ?? []).map(tool => ({
      name: tool.name, exposed: exposed.get(tool.name) ?? null, title: tool.title ?? null, description: tool.description ?? null,
      hints: tool.hints ?? {}, granted: granted.includes(tool.name), offered: true,
    }));
    for (const name of granted) if (!tools.some(tool => tool.name === name)) {
      tools.push({ name, exposed: exposed.get(name) ?? null, title: null, description: null, hints: {}, granted: true, offered: false });
    }
    tools.sort((a, b) => a.name.localeCompare(b.name));
    const url = this.endpoint(row);
    const state: ConnectorState = !row.enabled ? "disabled" : !url ? "needs_url"
      : row.check_status === "ok" ? "connected" : row.check_status === "auth_failed" ? "auth_failed"
      : row.check_status === "forbidden" ? "forbidden" : row.check_status === "blocked" ? "blocked"
      : row.check_status === "unavailable" ? "unavailable" : "not_checked";
    const launches = (this.db.query("SELECT launch_id FROM connector_capabilities WHERE revoked_at IS NULL ORDER BY created_at").all() as Array<{ launch_id: string }>)
      .map(entry => this.launch(entry.launch_id)).filter((entry): entry is LaunchIdentity => !!entry)
      .map(entry => ({ ...entry, granted: !!this.db.query("SELECT 1 FROM connector_launch_grants WHERE connector_id=? AND launch_id=?").get(id, entry.launch_id) }));
    return {
      id, name: row.name, namespace: row.slug, url: url?.href ?? (row.url || null), host: url?.host ?? null,
      enabled: !!row.enabled, state, credential: { set: !!row.credential, set_at: row.credential_set_at },
      server: json<{ name: string; version: string | null } | null>(row.server_info, null),
      checked_at: row.check_at, last_ok_at: row.check_ok_at, check_detail: row.check_detail,
      tools, discovered_count: catalog?.length ?? 0, granted_tools: granted,
      default_providers: json<Provider[]>(row.default_providers, []), launches,
    };
  }

  /** Live sessions holding a capability, filtered by liveness (the view lists recorded ones). */
  async liveLaunchIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const row of this.db.query("SELECT launch_id FROM connector_capabilities WHERE revoked_at IS NULL").all() as Array<{ launch_id: string }>) {
      const identity = this.launch(row.launch_id);
      if (identity && await this.deps.isLive(identity)) ids.add(identity.launch_id);
    }
    return ids;
  }

  audit(id: string, limit = 25) {
    this.must(id);
    return this.db.query("SELECT at,launch_id,provider,session_name,tool,outcome,duration_ms FROM connector_audit WHERE connector_id=? ORDER BY id DESC LIMIT ?").all(id, limit);
  }

  /* ---------- launch lifecycle ---------- */

  /** Whether new launches should carry the connector entry at all. */
  available(): boolean { return !!this.db.query("SELECT 1 FROM mcp_connectors WHERE enabled=1").get(); }

  /** Called after launch reservation. Grants only connectors that opted this provider in. */
  prepare(launchId: string): string | null {
    const identity = this.launch(launchId);
    if (!identity || !this.available()) return null;
    const token = `csconn_${randomBytes(32).toString("base64url")}`;
    this.db.transaction(() => {
      this.db.query(`INSERT INTO connector_capabilities (launch_id,token_hash,created_at) VALUES (?,?,?)
        ON CONFLICT(launch_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at,revoked_at=NULL`).run(launchId, hash(token), this.now());
      for (const row of this.db.query("SELECT id,default_providers FROM mcp_connectors WHERE enabled=1").all() as Array<{ id: string; default_providers: string }>) {
        if (json<string[]>(row.default_providers, []).includes(identity.agent)) {
          this.db.query("INSERT OR IGNORE INTO connector_launch_grants (connector_id,launch_id,granted_at) VALUES (?,?,?)").run(row.id, launchId, this.now());
        }
      }
    })();
    return token;
  }

  revoke(launchId: string): void {
    this.db.query("UPDATE connector_capabilities SET revoked_at=? WHERE launch_id=?").run(this.now(), launchId);
    this.db.query("DELETE FROM connector_launch_grants WHERE launch_id=?").run(launchId);
    this.abortWhere(entry => entry.launchId === launchId);
  }

  private capability(launchId: string): boolean {
    return !!this.db.query("SELECT 1 FROM connector_capabilities WHERE launch_id=? AND revoked_at IS NULL").get(launchId);
  }

  /* ---------- gateway surface (per-launch capability) ---------- */

  private authenticate(token: string): LaunchIdentity {
    const row = typeof token === "string" && CONNECTOR_TOKEN.test(token)
      ? this.db.query("SELECT launch_id FROM connector_capabilities WHERE token_hash=? AND revoked_at IS NULL").get(hash(token)) as { launch_id: string } | null : null;
    const identity = row && this.launch(row.launch_id);
    if (!identity) throw new ConnectorError("unauthorized", "Connector access is unavailable for this launch.");
    return identity;
  }

  async identity(token: string, requireLive = true): Promise<LaunchIdentity> {
    const identity = this.authenticate(token);
    if (requireLive && !await this.deps.isLive(identity)) throw new ConnectorError("unauthorized", "This session is not running.");
    return this.authenticate(token);
  }

  /** Connectors this launch may use right now, each with its granted tools that the server currently offers. */
  private grants(identity: LaunchIdentity): Array<{ row: Row; tools: Array<UpstreamTool & { exposed: string }> }> {
    const rows = this.db.query(`SELECT c.id FROM mcp_connectors c JOIN connector_launch_grants g ON g.connector_id=c.id
      WHERE g.launch_id=? AND c.enabled=1 AND c.url != '' ORDER BY c.slug`).all(identity.launch_id) as Array<{ id: string }>;
    return rows.map(({ id }) => this.must(id)).filter(row => this.endpoint(row)).map(row => {
      const granted = json<string[]>(row.granted_tools, []);
      const catalog = json<UpstreamTool[]>(row.catalog, []);
      const names = exposures(row.slug, catalog.map(tool => tool.name));
      const tools = catalog.filter(tool => granted.includes(tool.name) && names.get(tool.name))
        .map(tool => ({ ...tool, exposed: names.get(tool.name)! }));
      return { row, tools };
    });
  }

  private stale(row: Row): boolean { return !!row.catalog_stale || !row.catalog_at || this.now() - row.catalog_at >= CATALOG_TTL_MS; }

  /** One discovery per stale connector at a time; on failure the last catalog stays and calls still re-check grants. */
  private readonly refreshing = new Map<string, Promise<void>>();
  private refresh(row: Row): Promise<void> {
    const running = this.refreshing.get(row.id);
    if (running) return running;
    const task = (async () => {
      try {
        const tools = await this.client(row).listTools("settings", { timeoutMs: 15_000 });
        this.db.query("UPDATE mcp_connectors SET catalog=?,catalog_at=?,catalog_stale=0 WHERE id=? AND url=? AND credential IS ? AND enabled=1").run(JSON.stringify(tools), this.now(), row.id, row.url, row.credential);
      } catch { /* keep the previous catalog */ }
    })().finally(() => this.refreshing.delete(row.id));
    this.refreshing.set(row.id, task);
    return task;
  }

  private async refreshIfStale(identity: LaunchIdentity): Promise<void> {
    await Promise.all(this.grants(identity).filter(({ row }) => this.stale(row)).map(({ row }) => this.refresh(row)));
  }

  /** Changes whenever this launch's exposed tools change; the stdio bridge polls it to emit tools/list_changed. */
  async revision(token: string): Promise<string> {
    const identity = await this.identity(token);
    const view = this.grants(identity).map(({ row, tools }) => [row.id, row.url, row.credential_set_at, tools.map(tool => [tool.name, tool.inputSchema])]);
    return createHash("sha256").update(JSON.stringify(view)).digest("base64url").slice(0, 22);
  }

  async tools(token: string): Promise<ExposedTool[]> {
    const identity = await this.identity(token);
    await this.refreshIfStale(identity);
    return this.grants(this.authenticate(token)).flatMap(({ row, tools }) => tools.map(tool => ({
      name: tool.exposed,
      ...(tool.title ? { title: `${row.name}: ${tool.title}` } : {}),
      description: `[${row.name}, through Coding Sessions] ${tool.description ?? tool.name}`,
      inputSchema: tool.inputSchema,
      // Upstream annotations are untrusted and are not passed on: agents' own approval rules treat these tools as able to change things.
      annotations: { openWorldHint: true },
    })));
  }

  async connections(token: string) {
    const identity = await this.identity(token);
    return {
      launch: identity,
      connections: this.grants(identity).map(({ row, tools }) => {
        const server = json<{ name: string; version: string | null } | null>(row.server_info, null);
        return { connector: row.name, namespace: row.slug, host: this.endpoint(row)?.host ?? null,
          server_reported: server ? `${server.name}${server.version ? ` ${server.version}` : ""}` : "not reported",
          access: "only the tools the operator granted; they may read or change things on that server",
          tools: tools.map(tool => tool.exposed) };
      }),
    };
  }

  /** Throws unless this launch may call this tool right now. */
  private authorize(token: string, exposed: string): { identity: LaunchIdentity; row: Row; tool: UpstreamTool } {
    const identity = this.authenticate(token);
    for (const { row, tools } of this.grants(identity)) {
      if (!exposed.startsWith(`${row.slug}__`)) continue;
      const tool = tools.find(entry => entry.exposed === exposed);
      if (tool) return { identity, row, tool };
    }
    throw new ConnectorError("denied", "That connector tool is not granted to this session.");
  }

  private record(connectorId: string, identity: LaunchIdentity | null, tool: string, outcome: string, started: number): void {
    this.db.query("INSERT INTO connector_audit (at,connector_id,launch_id,provider,session_name,tool,outcome,duration_ms) VALUES (?,?,?,?,?,?,?,?)")
      .run(this.now(), connectorId, identity?.launch_id ?? null, identity?.agent ?? null, identity?.name ?? null, tool.slice(0, 128), outcome, Math.max(0, this.now() - started));
  }

  async call(token: string, exposed: string, args: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const started = this.now();
    const live = await this.identity(token);
    await this.refreshIfStale(live);
    let grant: ReturnType<Connectors["authorize"]>;
    try { grant = this.authorize(token, exposed); }
    catch (error) {
      const slug = exposed.split("__")[0] ?? "";
      const connector = this.db.query("SELECT id FROM mcp_connectors WHERE slug=?").get(slug) as { id: string } | null;
      if (connector) this.record(connector.id, live, exposed, "denied", started);
      throw error;
    }
    const { identity, row, tool } = grant;
    const problem = validateArguments(tool.inputSchema, args ?? {});
    if (problem) { this.record(row.id, identity, tool.name, "invalid", started); return invalid(`Invalid arguments for ${exposed}: ${problem}.`); }
    const busyLaunch = [...this.active].filter(entry => entry.launchId === identity.launch_id).length;
    const busyConnector = [...this.active].filter(entry => entry.connectorId === row.id).length;
    if (busyLaunch >= PER_LAUNCH || busyConnector >= PER_CONNECTOR) {
      this.record(row.id, identity, tool.name, "rate_limited", started);
      throw new ConnectorError("rate_limited", "Too many connector calls are running; wait for one to finish.");
    }
    const entry: Active = { connectorId: row.id, launchId: identity.launch_id, tool: tool.name, abort: new AbortController() };
    const onAbort = () => entry.abort.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) entry.abort.abort();
    this.active.add(entry);
    try {
      const result = this.scrub(row.id, await this.client(row).callTool(identity.launch_id, tool.name, args as Record<string, unknown> ?? {}, { signal: entry.abort.signal }));
      // Access may have been revoked while the upstream worked: re-check before delivering.
      // Any revoke, disable or credential change in between aborts this entry, even if access was restored since.
      try {
        if (entry.abort.signal.aborted) throw new Error();
        this.authorize(token, exposed);
        if (!await this.deps.isLive(identity) || entry.abort.signal.aborted) throw new Error();
        this.authorize(token, exposed);
      }
      catch { this.record(row.id, identity, tool.name, "revoked", started); throw new ConnectorError("denied", "Connector access was revoked while this call ran; its result was discarded."); }
      this.record(row.id, identity, tool.name, result.isError ? "tool_error" : "ok", started);
      return result;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (error instanceof DestinationError) { this.record(row.id, identity, tool.name, "blocked", started); throw new ConnectorError("unavailable", error.message); }
      if (error instanceof UpstreamRpcError) { this.record(row.id, identity, tool.name, "upstream_error", started); throw error; }
      const kind = error instanceof UpstreamError ? error.kind : "unavailable";
      const revoked = kind === "cancelled" && !signal?.aborted;
      this.record(row.id, identity, tool.name, revoked ? "revoked" : kind, started);
      if (kind === "auth" || kind === "forbidden") this.db.query("UPDATE mcp_connectors SET check_status=?,check_at=? WHERE id=?").run(kind === "auth" ? "auth_failed" : "forbidden", this.now(), row.id);
      if (revoked) throw new ConnectorError("denied", "Connector access was revoked while this call ran.");
      throw new ConnectorError("unavailable", error instanceof UpstreamError ? error.message : "The connected service is unavailable.");
    } finally {
      this.active.delete(entry);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Defense in depth: an upstream that reflects its own bearer must not hand it to an agent. */
  private scrub(id: string, result: Record<string, unknown>): Record<string, unknown> {
    const row = this.row(id);
    const secret = row ? this.credential(id, { url: row.url, credential: row.credential }) : null;
    if (!secret) return result;
    const text = JSON.stringify(result);
    if (!text.includes(secret) && !text.includes(JSON.stringify(secret).slice(1, -1))) return result;
    return JSON.parse(text.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]"));
  }

  /** Audit retention and capabilities of launches that are gone. */
  async prune(): Promise<void> {
    this.db.query("DELETE FROM connector_audit WHERE at<?").run(this.now() - AUDIT_RETENTION_MS);
    // An hour's grace keeps a launch that is still starting from losing its capability.
    for (const row of this.db.query("SELECT launch_id,revoked_at FROM connector_capabilities WHERE created_at<?").all(this.now() - 3600_000) as Array<{ launch_id: string; revoked_at: number | null }>) {
      const identity = this.launch(row.launch_id);
      if (identity && row.revoked_at === null && await this.deps.isLive(identity)) continue;
      this.db.query("DELETE FROM connector_launch_grants WHERE launch_id=?").run(row.launch_id);
      this.db.query("DELETE FROM connector_capabilities WHERE launch_id=?").run(row.launch_id);
    }
  }

}
