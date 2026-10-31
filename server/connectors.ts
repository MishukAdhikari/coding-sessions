import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import { createSecretCodec, loadTokenKey, type SecretCodec } from "./secrets";
import { PRESETS, presetEndpoint, type ConnectorIdentity, type ConnectorPreset } from "./connector-presets";
import { UpstreamClient, UpstreamError, UpstreamRpcError, type UpstreamTool } from "./connector-upstream";

type Environment = Record<string, string | undefined>;
export type Provider = "claude" | "codex" | "command-code";
const PROVIDERS: readonly Provider[] = ["claude", "codex", "command-code"];
export const CONNECTOR_TOKEN = /^csconn_[A-Za-z0-9_-]{43}$/;

export interface LaunchIdentity { launch_id: string; session_id: string; name: string; agent: Provider }
export type ConnectorState = "disabled" | "needs_credential" | "not_checked" | "connected" | "auth_failed" | "forbidden" | "unavailable";
export interface ConnectorView {
  id: string; preset: string; label: string; host: string;
  enabled: boolean; state: ConnectorState;
  credential: { set: boolean; set_at: number | null };
  identity: (ConnectorIdentity & { source: "upstream" }) | null;
  checked_at: number | null; last_ok_at: number | null;
  tools: Array<{ name: string; title: string | null; description: string | null; grantable: boolean; granted: boolean; discovered: boolean; recommended: boolean }>;
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
  id: string; preset: string; enabled: number; credential: string | null; credential_set_at: number | null;
  granted_tools: string; default_providers: string; catalog: string | null; catalog_at: number | null; catalog_stale: number;
  identity: string | null; check_status: string | null; check_at: number | null; check_ok_at: number | null; created_at: number;
}
interface Active { connectorId: string; launchId: string; tool: string; abort: AbortController }
export interface ConnectorDependencies {
  database: Database;
  isLive(identity: LaunchIdentity): Promise<boolean>;
  /** Defaults to a codec built from the configured key, refusing to work without one. */
  codec?: () => SecretCodec;
  fetch?: typeof fetch;
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
 * Outbound MCP connectors: a server-held upstream credential, explicit tool, provider and
 * launch grants, and a per-launch capability checked on every call. The capability is a
 * separate audience from the communicator mailbox.
 */
export class Connectors {
  private readonly now: () => number;
  private readonly env: Environment;
  private readonly clients = new Map<string, UpstreamClient>();
  private readonly active = new Set<Active>();
  /** Latest-wins settings checks; replacing, disabling or removing aborts the one running. */
  private readonly checks = new Map<string, AbortController>();
  constructor(private readonly deps: ConnectorDependencies) {
    this.now = deps.now ?? Date.now;
    this.env = deps.env ?? process.env;
  }
  private get db() { return this.deps.database; }
  private codec(): SecretCodec { return (this.deps.codec ?? (() => connectorCodec(this.env)))(); }

  private row(id: string): Row | null { return this.db.query("SELECT * FROM mcp_connectors WHERE id=?").get(id) as Row | null; }
  private must(id: string): Row & { presetDef: ConnectorPreset } {
    const row = this.row(id);
    const presetDef = row && PRESETS[row.preset];
    if (!row || !presetDef) throw new ConnectorError("not_found", "That connector does not exist.");
    return { ...row, presetDef };
  }
  private launch(launchId: string): LaunchIdentity | null {
    const row = this.db.query("SELECT launch_id, screen, name, provider FROM launches WHERE launch_id=? AND phase != 'failed'")
      .get(launchId) as { launch_id: string; screen: string; name: string; provider: string } | null;
    if (!row || !PROVIDERS.includes(row.provider as Provider)) return null;
    return { launch_id: row.launch_id, session_id: `m:${row.screen}`, name: row.name, agent: row.provider as Provider };
  }

  private client(row: Row & { presetDef: ConnectorPreset }): UpstreamClient {
    let client = this.clients.get(row.id);
    if (!client) {
      const id = row.id;
      client = new UpstreamClient({
        url: presetEndpoint(row.presetDef, this.env), fetch: this.deps.fetch, now: this.now,
        credential: () => this.credential(id),
        onToolsChanged: () => { this.db.query("UPDATE mcp_connectors SET catalog_stale=1 WHERE id=?").run(id); },
      });
      this.clients.set(id, client);
    }
    return client;
  }
  /** Opened only at the moment of an upstream request; never returned by any read. */
  private credential(id: string): string {
    const row = this.row(id);
    if (!row?.credential || !row.credential.startsWith(SEALED)) throw new ConnectorError("unavailable", "This connector has no usable credential.");
    try { return this.codec().openSecret(row.credential, `mcp-connector:${id}:credential`); }
    catch (error) { throw error instanceof ConnectorError ? error : new ConnectorError("storage", "The connector credential cannot be opened with this server's key."); }
  }
  private invalidate(id: string): void {
    this.checks.get(id)?.abort(); this.checks.delete(id);
    this.clients.get(id)?.reset(); this.clients.delete(id);
  }
  private abortWhere(match: (active: Active) => boolean): void {
    for (const entry of this.active) if (match(entry)) entry.abort.abort();
  }

  /* ---------- operator surface (browser session only; see connectors-route.ts) ---------- */

  presets() { return Object.values(PRESETS).map(p => ({ id: p.id, label: p.label, host: new URL(p.url).host, added: !!this.db.query("SELECT 1 FROM mcp_connectors WHERE preset=?").get(p.id) })); }

  add(presetId: string): ConnectorView {
    const preset = PRESETS[presetId];
    if (!preset) return invalid("Only the listed connectors can be added in this release.");
    presetEndpoint(preset, this.env);
    const existing = this.db.query("SELECT id FROM mcp_connectors WHERE preset=?").get(presetId) as { id: string } | null;
    if (existing) return this.view(existing.id);
    const id = randomUUID();
    this.db.query("INSERT INTO mcp_connectors (id,preset,enabled,created_at) VALUES (?,?,1,?)").run(id, presetId, this.now());
    return this.view(id);
  }

  setCredential(id: string, value: unknown): ConnectorView {
    this.must(id);
    if (typeof value !== "string" || !/^[\x21-\x7e]{16,4096}$/.test(value.trim())) return invalid("Paste the token as a single line of 16–4096 visible characters.");
    const sealed = this.codec().sealSecret(value.trim(), `mcp-connector:${id}:credential`);
    if (!sealed.startsWith(SEALED)) throw new ConnectorError("storage", "Connector credentials must be encrypted. Nothing was saved.");
    this.db.query(`UPDATE mcp_connectors SET credential=?,credential_set_at=?,identity=NULL,check_status=NULL,check_at=NULL,check_ok_at=NULL,catalog_stale=1 WHERE id=?`)
      .run(sealed, this.now(), id);
    this.invalidate(id);
    // Results computed with the previous credential must not be delivered under the new one.
    this.abortWhere(entry => entry.connectorId === id);
    return this.view(id);
  }

  setEnabled(id: string, enabled: boolean): ConnectorView {
    this.must(id);
    this.db.query("UPDATE mcp_connectors SET enabled=? WHERE id=?").run(enabled ? 1 : 0, id);
    if (!enabled) { this.abortWhere(entry => entry.connectorId === id); this.invalidate(id); }
    return this.view(id);
  }

  /** Removes the local credential and every grant immediately. Upstream revocation is the operator's step. */
  remove(id: string): void {
    this.must(id);
    this.db.query("DELETE FROM mcp_connectors WHERE id=?").run(id);
    this.abortWhere(entry => entry.connectorId === id);
    this.invalidate(id);
  }

  setTools(id: string, tools: unknown): ConnectorView {
    const row = this.must(id);
    if (!Array.isArray(tools) || tools.some(tool => typeof tool !== "string")) return invalid("tools must be a list of tool names.");
    const wanted = [...new Set(tools as string[])];
    const refused = wanted.find(tool => !row.presetDef.grantable.includes(tool));
    if (refused) return invalid(`${refused} cannot be granted in this release: only curated read-only tools are available.`);
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

  /** A real discovery against the upstream: the only thing that may mark a connector connected. */
  async check(id: string): Promise<ConnectorView> {
    const row = this.must(id);
    if (!row.credential || !row.enabled) return this.view(id);
    this.checks.get(id)?.abort();
    const abort = new AbortController();
    this.checks.set(id, abort);
    const client = this.client(row);
    client.reset("settings");
    // Writes apply only if this is still the latest check for the same credential and state.
    const current = () => this.checks.get(id) === abort && !abort.signal.aborted;
    const guard = "WHERE id=? AND credential=? AND enabled=1";
    let status = "ok";
    try {
      const session = await client.session("settings", { timeoutMs: 20_000, signal: abort.signal });
      const tools = await client.listTools("settings", { timeoutMs: 20_000, signal: abort.signal });
      const identity = row.presetDef.identity(session.instructions);
      if (current()) this.db.query(`UPDATE mcp_connectors SET catalog=?,catalog_at=?,catalog_stale=0,identity=?,check_ok_at=? ${guard}`)
        .run(JSON.stringify(tools), this.now(), identity ? JSON.stringify(identity) : null, this.now(), id, row.credential);
    } catch (error) {
      status = error instanceof UpstreamError ? ({ auth: "auth_failed", forbidden: "forbidden" } as Record<string, string>)[error.kind] ?? "unavailable" : "unavailable";
      if (status === "auth_failed" && current()) this.db.query(`UPDATE mcp_connectors SET identity=NULL ${guard}`).run(id, row.credential);
    }
    if (current()) {
      this.db.query(`UPDATE mcp_connectors SET check_status=?,check_at=? ${guard}`).run(status, this.now(), id, row.credential);
      this.checks.delete(id);
    }
    return this.view(id);
  }

  list(): ConnectorView[] {
    return (this.db.query("SELECT id FROM mcp_connectors ORDER BY created_at").all() as Array<{ id: string }>).map(row => this.view(row.id));
  }

  view(id: string): ConnectorView {
    const row = this.must(id);
    const preset = row.presetDef;
    const catalog = json<UpstreamTool[] | null>(row.catalog, null);
    const granted = json<string[]>(row.granted_tools, []);
    const names = new Set([...preset.grantable, ...(catalog ?? []).map(tool => tool.name)]);
    const tools = [...names].map(name => {
      const found = catalog?.find(tool => tool.name === name);
      return { name, title: found?.title ?? null, description: found?.description ?? null, grantable: preset.grantable.includes(name),
        granted: granted.includes(name), discovered: !!found, recommended: preset.recommended.includes(name) };
    }).sort((a, b) => Number(b.grantable) - Number(a.grantable) || a.name.localeCompare(b.name));
    const state: ConnectorState = !row.enabled ? "disabled" : !row.credential ? "needs_credential"
      : row.check_status === "ok" ? "connected" : row.check_status === "auth_failed" ? "auth_failed"
      : row.check_status === "forbidden" ? "forbidden" : row.check_status === "unavailable" ? "unavailable" : "not_checked";
    const identity = json<ConnectorIdentity | null>(row.identity, null);
    const launches = (this.db.query("SELECT launch_id FROM connector_capabilities WHERE revoked_at IS NULL ORDER BY created_at").all() as Array<{ launch_id: string }>)
      .map(entry => this.launch(entry.launch_id)).filter((entry): entry is LaunchIdentity => !!entry)
      .map(entry => ({ ...entry, granted: !!this.db.query("SELECT 1 FROM connector_launch_grants WHERE connector_id=? AND launch_id=?").get(id, entry.launch_id) }));
    return {
      id, preset: preset.id, label: preset.label, host: presetEndpoint(preset, this.env).host,
      enabled: !!row.enabled, state, credential: { set: !!row.credential, set_at: row.credential_set_at },
      identity: identity ? { ...identity, source: "upstream" } : null,
      checked_at: row.check_at, last_ok_at: row.check_ok_at,
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

  /** Connectors this launch may use right now, each with its granted, discovered, curated tools. */
  private grants(identity: LaunchIdentity): Array<{ row: Row & { presetDef: ConnectorPreset }; tools: UpstreamTool[] }> {
    const rows = this.db.query(`SELECT c.id FROM mcp_connectors c JOIN connector_launch_grants g ON g.connector_id=c.id
      WHERE g.launch_id=? AND c.enabled=1 AND c.credential IS NOT NULL ORDER BY c.preset`).all(identity.launch_id) as Array<{ id: string }>;
    return rows.map(({ id }) => {
      const row = this.must(id);
      const granted = json<string[]>(row.granted_tools, []);
      const tools = json<UpstreamTool[]>(row.catalog, []).filter(tool => granted.includes(tool.name) && row.presetDef.grantable.includes(tool.name));
      return { row, tools };
    });
  }

  private stale(row: Row): boolean { return !!row.catalog_stale || !row.catalog_at || this.now() - row.catalog_at >= CATALOG_TTL_MS; }

  /** One discovery per stale connector at a time; on failure the last catalog stays and calls still re-check grants. */
  private readonly refreshing = new Map<string, Promise<void>>();
  private refresh(row: Row & { presetDef: ConnectorPreset }): Promise<void> {
    const running = this.refreshing.get(row.id);
    if (running) return running;
    const task = (async () => {
      try {
        const tools = await this.client(row).listTools("settings", { timeoutMs: 15_000 });
        this.db.query("UPDATE mcp_connectors SET catalog=?,catalog_at=?,catalog_stale=0 WHERE id=? AND credential=? AND enabled=1").run(JSON.stringify(tools), this.now(), row.id, row.credential);
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
    const view = this.grants(identity).map(({ row, tools }) => [row.id, row.credential_set_at, tools.map(tool => [tool.name, tool.inputSchema])]);
    return createHash("sha256").update(JSON.stringify(view)).digest("base64url").slice(0, 22);
  }

  async tools(token: string): Promise<ExposedTool[]> {
    const identity = await this.identity(token);
    await this.refreshIfStale(identity);
    return this.grants(this.authenticate(token)).flatMap(({ row, tools }) => tools.map(tool => ({
      name: `${row.presetDef.id}__${tool.name}`,
      ...(tool.title ? { title: `${row.presetDef.label}: ${tool.title}` } : {}),
      description: `[${row.presetDef.label} · read-only grant] ${tool.description ?? tool.name}`,
      inputSchema: tool.inputSchema,
      // Upstream annotations are untrusted; these reflect the local grant policy.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    })));
  }

  async connections(token: string) {
    const identity = await this.identity(token);
    return {
      launch: identity,
      connections: this.grants(identity).map(({ row, tools }) => {
        const who = json<ConnectorIdentity | null>(row.identity, null);
        return { connector: row.presetDef.id, label: row.presetDef.label, host: presetEndpoint(row.presetDef, this.env).host,
          account: who ? `${who.account}${who.role ? ` (${who.role})` : ""}` : "not reported", access: "read-only",
          tools: tools.map(tool => `${row.presetDef.id}__${tool.name}`) };
      }),
    };
  }

  /** Throws unless this launch may call this tool right now. */
  private authorize(token: string, exposed: string): { identity: LaunchIdentity; row: Row & { presetDef: ConnectorPreset }; tool: UpstreamTool } {
    const identity = this.authenticate(token);
    const separator = exposed.indexOf("__");
    const presetId = separator > 0 ? exposed.slice(0, separator) : "";
    const name = exposed.slice(separator + 2);
    for (const { row, tools } of this.grants(identity)) {
      if (row.presetDef.id !== presetId) continue;
      const tool = tools.find(entry => entry.name === name);
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
      const presetId = exposed.split("__")[0] ?? "";
      const connector = this.db.query("SELECT id FROM mcp_connectors WHERE preset=?").get(presetId) as { id: string } | null;
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
    const secret = this.credential(id);
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
