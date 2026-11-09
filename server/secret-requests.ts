/**
 * Secret and connector requests: an agent asks the member for a value (or a connected MCP
 * server) through a one-time link, instead of asking in chat or telling them to edit files.
 *
 *   agent  ──request_secret──▶  pending request + https://<origin>/#secret-request=<token>
 *   member opens the link (signed in) ──Save──▶ SecretStore.set ──▶ every session's secrets file
 *
 * Promises:
 *  - Only sha256(token) is stored, and it is cleared the moment the request leaves pending,
 *    whether fulfilled, declined, superseded or expired. Links last 15 minutes.
 *  - No value passes through here except on its way into the existing write-only stores;
 *    no view, result or log line carries one.
 *  - Creating a request grants nothing. Only a signed-in browser session can fulfil one, and
 *    overriding an existing secret, or sending a token to a connector, needs a step-up.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { checkName, SecretStoreError } from "./secret-store";
import { DestinationError, networkPolicy, validateServerUrl } from "./connector-net";
import { ConnectorError, type ConnectorView } from "./connectors";

export type RequestKind = "secret" | "connector";
export type RequestState = "pending" | "fulfilled" | "declined" | "expired";
export type ConnectorAuth = "bearer" | "oauth";
export const REQUEST_TTL_MS = 15 * 60_000;
export const REQUEST_TOKEN = /^csreq_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REASON_MAX = 500;
const PER_SESSION_PENDING = 3;
const PER_SESSION_CREATED = 10;
const WINDOW_MS = 10 * 60_000;
const TOTAL_PENDING = 20;
const GONE = "This link has expired or was already used. Ask the agent for a new one.";

export class SecretRequestError extends Error {
  constructor(message: string, readonly status = 400, readonly code: "invalid" | "gone" | "exists" | "step_up" | "rate_limited" | "conflict" | "not_found" = "invalid") {
    super(message); this.name = "SecretRequestError";
  }
}

/** Who asked. Session identity comes from the authenticated launch row, never from arguments. */
export interface Requester {
  by: "session" | "operator";
  launchId: string | null;
  screen: string | null;
  sessionName: string | null;
  agent: string | null;
}

interface Row {
  id: string; kind: RequestKind; name: string; reason: string; url: string | null; auth: ConnectorAuth | null;
  screen: string | null; launch_id: string | null; session_name: string | null; agent: string | null;
  requested_by: "session" | "operator"; token_hash: string | null; created_at: number; expires_at: number;
  state: RequestState; resolved_at: number | null; connector_id: string | null; detail: string | null;
}

export interface SecretSink {
  set(name: unknown, value: unknown): { name: string; updatedAt: number };
  describe(name: unknown): { name: string; set: boolean; updatedAt: number | null; source: string | null };
  list(): { secrets: Array<{ name: string; updatedAt: number }>; sources: Array<{ label: string; names: string[]; lastSyncAt: number | null }> };
}

/** The Connectors methods a request uses; the same paths Settings › Connectors uses. */
export interface ConnectorPort {
  list(): ConnectorView[];
  view(id: string): ConnectorView;
  add(input: { name?: unknown; url?: unknown; token?: unknown }): Promise<ConnectorView>;
  setCredential(id: string, value: unknown): ConnectorView;
  setAuthMode(id: string, value: unknown): ConnectorView;
  setDefaultProviders(id: string, providers: unknown): ConnectorView;
  setLaunchGrant(id: string, launchId: unknown, granted: boolean): ConnectorView;
  setTools(id: string, tools: unknown): ConnectorView;
  check(id: string): Promise<ConnectorView>;
}

export type EnvironmentState = "current" | "outdated" | "missing" | "unknown";

export interface SecretRequestDependencies {
  database: Database;
  /** The configured app origin; links are built from it, never from a request's Host. */
  origin: string;
  secrets: () => SecretSink;
  connectors?: ConnectorPort;
  now?: () => number;
  log?: (line: string) => void;
  /** Rewrite running sessions' secrets files. Fire and forget. */
  onSecretsChanged?: () => void;
  /** Whether a launch's environment holds a name's current value (keyed hashes, never values). */
  inLaunchEnvironment?: (launchId: string, name: string) => Promise<EnvironmentState>;
  secretsFile?: (launchId: string) => string | null;
}

export interface RequestView {
  id: string;
  kind: RequestKind;
  name: string;
  reason: string;
  state: RequestState;
  created_at: number;
  expires_at: number;
  requested_by: "session" | "operator";
  session: { name: string | null; agent: string | null; id: string | null } | null;
  url: string | null;
  host: string | null;
  auth: ConnectorAuth | null;
  /** Secret: whether a value for the name already reaches sessions, and from where. */
  existing: { set: boolean; source: string | null; updated_at: number | null } | null;
  /** Connector: what is configured under this name now. */
  connector: { id: string; host: string | null; state: string; auth_mode: string; credential_set: boolean; url_matches: boolean } | null;
  detail: string | null;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
// C0 controls except newline, DEL, and bidirectional overrides that could disguise text.
const UNSAFE_TEXT = /[\u0000-\u0009\u000b-\u001f\u007f‎‏‪-‮⁦-⁩]/g;

/** Plain text, bounded, with nothing that can reorder or hide what the member reads. */
export function cleanReason(value: unknown): string {
  if (typeof value !== "string") throw new SecretRequestError("Give a reason: one or two sentences on what the value is for.");
  const text = value.replace(/\r\n?/g, "\n").replace(UNSAFE_TEXT, "").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < 3) throw new SecretRequestError("Give a reason: one or two sentences on what the value is for.");
  if (text.length > REASON_MAX) throw new SecretRequestError(`Keep the reason under ${REASON_MAX} characters.`);
  return text;
}

function connectorName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 60 || new RegExp(UNSAFE_TEXT.source).test(name)) throw new SecretRequestError("Give the connector a name of 1–60 characters.");
  return name;
}

/** The connector provider group an agent belongs to (cmd:<slug> launches are "presets"). */
export function providerGroup(agent: string | null): string | null {
  if (!agent) return null;
  if (/^cmd:[a-z0-9][a-z0-9-]{0,30}$/.test(agent)) return "presets";
  return ["claude", "codex", "command-code"].includes(agent) ? agent : null;
}

const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString();

export class SecretRequests {
  private readonly now: () => number;
  constructor(private readonly deps: SecretRequestDependencies) { this.now = deps.now ?? Date.now; }
  private get db() { return this.deps.database; }
  private log(row: Pick<Row, "id" | "kind" | "name" | "screen" | "requested_by">, outcome: string): void {
    // Names and ids only: never a value, a token or the free-text reason.
    this.deps.log?.(`secret-request ${row.id} ${row.kind} ${row.name} by=${row.requested_by}${row.screen ? ` session=${row.screen}` : ""} ${outcome}`);
  }

  /** Pending requests past their time become expired, and their token hashes go. */
  private expire(): void {
    const rows = this.db.query("SELECT id,kind,name,screen,requested_by FROM secret_requests WHERE state='pending' AND expires_at<=?").all(this.now()) as Row[];
    if (!rows.length) return;
    this.db.query("UPDATE secret_requests SET state='expired',token_hash=NULL,resolved_at=? WHERE state='pending' AND expires_at<=?").run(this.now(), this.now());
    for (const row of rows) this.log(row, "expired");
  }

  /* ---------- create (MCP surfaces) ---------- */

  async create(input: Record<string, unknown>, requester: Requester): Promise<{ request_id: string; url: string; expires_at: string; state: "pending" }> {
    const kind: RequestKind = input.kind === "connector" ? "connector" : "secret";
    let name: string;
    let url: string | null = null;
    let auth: ConnectorAuth | null = null;
    if (kind === "secret") {
      try { name = checkName(input.name); }
      catch (error) { throw new SecretRequestError(error instanceof SecretStoreError ? error.message : "Invalid name."); }
    } else {
      name = connectorName(input.name);
      try { url = validateServerUrl(input.url, networkPolicy()).href; }
      catch (error) { throw new SecretRequestError(error instanceof DestinationError ? error.message : "That URL cannot be used."); }
      if (input.auth !== undefined && input.auth !== "bearer" && input.auth !== "oauth") throw new SecretRequestError('auth must be "bearer" or "oauth".');
      auth = (input.auth as ConnectorAuth | undefined) ?? "bearer";
    }
    const reason = cleanReason(input.reason);
    const token = `csreq_${randomBytes(32).toString("base64url")}`;
    const id = randomUUID();
    const now = this.now();
    this.db.transaction(() => {
      this.expire();
      // One live link per session, kind and name: a new request replaces the older one.
      const superseded = this.db.query(`SELECT id,kind,name,screen,requested_by FROM secret_requests WHERE state='pending' AND kind=? AND name=?
        AND requested_by=? AND COALESCE(screen,'')=COALESCE(?,'')`).all(kind, name, requester.by, requester.screen) as Row[];
      for (const row of superseded) {
        this.db.query("UPDATE secret_requests SET state='expired',token_hash=NULL,resolved_at=?,detail='Replaced by a newer request.' WHERE id=?").run(now, row.id);
        this.log(row, "superseded");
      }
      const count = (sql: string, ...args: Array<string | number | null>) => (this.db.query(sql).get(...args) as { n: number }).n;
      if (requester.screen) {
        if (count("SELECT COUNT(*) AS n FROM secret_requests WHERE state='pending' AND screen=?", requester.screen) >= PER_SESSION_PENDING) {
          throw new SecretRequestError(`This session already has ${PER_SESSION_PENDING} requests waiting on the member. Wait for them to be answered or to expire.`, 429, "rate_limited");
        }
        if (count("SELECT COUNT(*) AS n FROM secret_requests WHERE screen=? AND created_at>?", requester.screen, now - WINDOW_MS) >= PER_SESSION_CREATED) {
          throw new SecretRequestError("Too many requests from this session; wait ten minutes.", 429, "rate_limited");
        }
      }
      if (count("SELECT COUNT(*) AS n FROM secret_requests WHERE state='pending'") >= TOTAL_PENDING) {
        throw new SecretRequestError(`${TOTAL_PENDING} requests are already waiting on the member. Wait for some to be answered or to expire.`, 429, "rate_limited");
      }
      this.db.query(`INSERT INTO secret_requests (id,kind,name,reason,url,auth,screen,launch_id,session_name,agent,requested_by,token_hash,created_at,expires_at,state)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`).run(id, kind, name, reason, url, auth, requester.screen, requester.launchId,
        requester.sessionName, requester.agent, requester.by, hash(token), now, now + REQUEST_TTL_MS);
    })();
    this.log({ id, kind, name, screen: requester.screen, requested_by: requester.by }, "created");
    return { request_id: id, url: `${this.deps.origin}/#secret-request=${token}`, expires_at: new Date(now + REQUEST_TTL_MS).toISOString(), state: "pending" };
  }

  /* ---------- the member's side (browser session only; see secret-requests-route.ts) ---------- */

  /** By the link's token, or by id from Settings. Anything not pending reads as gone. */
  private pendingRow(ref: { token?: unknown; id?: unknown }): Row {
    this.expire();
    let row: Row | null = null;
    if (typeof ref.token === "string" && REQUEST_TOKEN.test(ref.token)) {
      row = this.db.query("SELECT * FROM secret_requests WHERE token_hash=?").get(hash(ref.token)) as Row | null;
    } else if (ref.token === undefined && typeof ref.id === "string" && UUID.test(ref.id)) {
      row = this.db.query("SELECT * FROM secret_requests WHERE id=?").get(ref.id) as Row | null;
    }
    if (!row || row.state !== "pending") throw new SecretRequestError(GONE, 410, "gone");
    return row;
  }

  private findConnector(name: string): ConnectorView | null {
    const wanted = name.toLowerCase();
    return this.deps.connectors?.list().find(view => view.name.toLowerCase() === wanted) ?? null;
  }

  private view(row: Row): RequestView {
    let existing: RequestView["existing"] = null;
    let connector: RequestView["connector"] = null;
    if (row.kind === "secret") {
      const found = this.deps.secrets().describe(row.name);
      existing = { set: found.set, source: found.source, updated_at: found.updatedAt };
    } else {
      const found = this.findConnector(row.name);
      if (found) connector = { id: found.id, host: found.host, state: found.state, auth_mode: found.auth.mode, credential_set: found.credential.set, url_matches: found.url === row.url };
    }
    return {
      id: row.id, kind: row.kind, name: row.name, reason: row.reason, state: row.state,
      created_at: row.created_at, expires_at: row.expires_at, requested_by: row.requested_by,
      session: row.screen || row.session_name ? { name: row.session_name, agent: row.agent, id: row.screen ? `m:${row.screen}` : null } : null,
      url: row.url, host: row.url ? new URL(row.url).host : null, auth: row.auth, existing, connector, detail: row.detail,
    };
  }

  lookup(ref: { token?: unknown; id?: unknown }): RequestView {
    return this.view(this.pendingRow(ref));
  }

  pending(): RequestView[] {
    this.expire();
    return (this.db.query("SELECT * FROM secret_requests WHERE state='pending' ORDER BY created_at").all() as Row[]).map(row => this.view(row));
  }

  /** For session cards: which sessions are waiting on the member, by screen. */
  pendingByScreen(): Map<string, Array<{ id: string; kind: RequestKind; name: string }>> {
    this.expire();
    const out = new Map<string, Array<{ id: string; kind: RequestKind; name: string }>>();
    for (const row of this.db.query("SELECT id,kind,name,screen FROM secret_requests WHERE state='pending' AND screen IS NOT NULL ORDER BY created_at").all() as Row[]) {
      out.set(row.screen!, [...out.get(row.screen!) ?? [], { id: row.id, kind: row.kind, name: row.name }]);
    }
    return out;
  }

  private resolve(row: Row, state: "fulfilled" | "declined", extra: { connectorId?: string } = {}): boolean {
    const changed = this.db.query("UPDATE secret_requests SET state=?,token_hash=NULL,resolved_at=?,detail=NULL,connector_id=COALESCE(?,connector_id) WHERE id=? AND state='pending'")
      .run(state, this.now(), extra.connectorId ?? null, row.id).changes > 0;
    if (changed) this.log(row, state);
    return changed;
  }

  /**
   * Store the pasted value as an ordinary secret. A name that already reaches sessions
   * (stored here or delivered by a secret manager) is replaced only with replace: true and a
   * spent step-up grant. stepUp is called only when it is needed, so a grant is not wasted.
   */
  fulfilSecret(ref: { token?: unknown; id?: unknown }, value: unknown, options: { replace?: boolean; stepUp: () => boolean }): { ok: true; name: string; state: "fulfilled" } {
    const row = this.pendingRow(ref);
    if (row.kind !== "secret") throw new SecretRequestError("This request is for a connector.", 400);
    const existing = this.deps.secrets().describe(row.name);
    if (existing.set) {
      if (options.replace !== true) throw new SecretRequestError(`${row.name} already has a value${existing.source ? ` from ${existing.source}` : ""}. Choose Replace to overwrite it.`, 409, "exists");
      if (!options.stepUp()) throw new SecretRequestError(`Confirm it's you to replace ${row.name}.`, 403, "step_up");
    }
    try { this.deps.secrets().set(row.name, value); }
    catch (error) { throw new SecretRequestError(error instanceof SecretStoreError ? error.message : "The secret could not be saved.", error instanceof SecretStoreError ? error.status : 500); }
    this.resolve(row, "fulfilled");
    this.deps.onSecretsChanged?.();
    return { ok: true, name: row.name, state: "fulfilled" };
  }

  decline(ref: { token?: unknown; id?: unknown }): { ok: true; state: "declined" } {
    const row = this.pendingRow(ref);
    this.resolve(row, "declined");
    return { ok: true, state: "declined" };
  }

  /* ---------- connectors ---------- */

  private connectors(): ConnectorPort {
    if (!this.deps.connectors) throw new SecretRequestError("Connectors are not available on this server.", 503);
    return this.deps.connectors;
  }

  /** The connector this request names: existing (same URL) or new. A name on another URL is refused. */
  private async connectorFor(row: Row, token?: string): Promise<{ view: ConnectorView; created: boolean }> {
    const found = this.findConnector(row.name);
    if (found) {
      if (found.url !== row.url) throw new SecretRequestError(`A connector named ${found.name} already points to ${found.host ?? "another server"}. Change it in Settings › Connectors instead.`, 409, "conflict");
      return { view: found, created: false };
    }
    try { return { view: await this.connectors().add({ name: row.name, url: row.url, ...(token ? { token } : {}) }), created: true }; }
    catch (error) { throw this.connectorFailure(error); }
  }

  private connectorFailure(error: unknown): SecretRequestError {
    if (error instanceof SecretRequestError) return error;
    if (error instanceof ConnectorError) return new SecretRequestError(error.message, error.code === "storage" || error.code === "unavailable" ? 503 : 400);
    return new SecretRequestError("The connector could not be saved.", 500);
  }

  /**
   * Bearer: the member's token is stored through Connectors (sealed, never given to agents),
   * then checked. Sending a token to a server always needs a step-up: the URL came from an
   * agent. The request is fulfilled only after the check succeeds; otherwise it stays
   * pending, so the member can fix the token and try again from the same link.
   */
  async connectorBearer(ref: { token?: unknown; id?: unknown }, token: unknown, options: { stepUp: () => boolean }): Promise<Record<string, unknown>> {
    const row = this.pendingRow(ref);
    if (row.kind !== "connector") throw new SecretRequestError("This request is for a secret.", 400);
    if (typeof token !== "string" || !token.trim()) throw new SecretRequestError("Paste the token.", 422);
    if (!options.stepUp()) throw new SecretRequestError(`Confirm it's you before sending a token to ${new URL(row.url!).host}.`, 403, "step_up");
    const { view, created } = await this.connectorFor(row, token);
    if (!created) {
      try {
        if (view.auth.mode !== "bearer") this.connectors().setAuthMode(view.id, "bearer");
        this.connectors().setCredential(view.id, token);
      } catch (error) { throw this.connectorFailure(error); }
    }
    this.db.query("UPDATE secret_requests SET connector_id=? WHERE id=?").run(view.id, row.id);
    return this.finishConnector({ ...row, connector_id: view.id });
  }

  /**
   * OAuth: make sure the connector exists in OAuth mode and hand its id back; the page then
   * starts the existing sign-in, whose callback is this app's own HTTPS origin. A connector
   * that is already connected is not switched (that would end its sign-in): it is granted.
   */
  async connectorOAuth(ref: { token?: unknown; id?: unknown }): Promise<Record<string, unknown>> {
    const row = this.pendingRow(ref);
    if (row.kind !== "connector") throw new SecretRequestError("This request is for a secret.", 400);
    const { view } = await this.connectorFor(row);
    this.db.query("UPDATE secret_requests SET connector_id=? WHERE id=?").run(view.id, row.id);
    if (view.state === "connected") return this.finishConnector({ ...row, connector_id: view.id });
    try { if (view.auth.mode !== "oauth") this.connectors().setAuthMode(view.id, "oauth"); }
    catch (error) { throw this.connectorFailure(error); }
    return { ok: true, state: "pending", connector_id: view.id, next: "oauth" };
  }

  /** Called once an OAuth sign-in completes: finish every pending request for that connector. */
  async oauthConnected(connectorId: string): Promise<void> {
    this.expire();
    const rows = this.db.query("SELECT * FROM secret_requests WHERE state='pending' AND kind='connector' AND connector_id=?").all(connectorId) as Row[];
    for (const row of rows) { try { await this.finishConnector(row); } catch {} }
  }

  /** Check first; only a working connection is granted and fulfils the request. */
  private async finishConnector(row: Row): Promise<Record<string, unknown>> {
    const connectors = this.connectors();
    const id = row.connector_id!;
    let view: ConnectorView;
    try { view = await connectors.check(id); } catch (error) { throw this.connectorFailure(error); }
    if (view.state !== "connected") {
      const detail = view.check_detail ?? ({ auth_failed: "The server refused the credential.", forbidden: "The server refused access.", blocked: "That server's address is not allowed.", unavailable: "The server could not be reached." } as Record<string, string>)[view.state]
        ?? "The connection could not be confirmed.";
      this.db.query("UPDATE secret_requests SET detail=? WHERE id=?").run(detail, row.id);
      return { ok: false, state: "pending", connector_state: view.state, detail };
    }
    try {
      const group = providerGroup(row.agent);
      if (group && !view.default_providers.includes(group as never)) connectors.setDefaultProviders(id, [...view.default_providers, group]);
      // A running session gets the grant only if it started with the connectors gateway.
      if (row.launch_id) { try { connectors.setLaunchGrant(id, row.launch_id, true); } catch {} }
      const exposable = view.tools.filter(tool => tool.offered && tool.exposed).map(tool => tool.name);
      const tools = [...new Set([...view.granted_tools, ...exposable])];
      if (tools.length) view = connectors.setTools(id, tools);
    } catch (error) { throw this.connectorFailure(error); }
    this.resolve(row, "fulfilled", { connectorId: id });
    return { ok: true, state: "fulfilled", connector: { name: view.name, host: view.host, tools: view.granted_tools.length } };
  }

  /* ---------- status (MCP surfaces; names and states only) ---------- */

  private latest(kind: RequestKind, name: string, screen: string | null): { id: string; state: RequestState; expires_at: string | null; detail: string | null } | null {
    this.expire();
    const row = (screen
      ? this.db.query("SELECT * FROM secret_requests WHERE kind=? AND name=? AND screen=? ORDER BY created_at DESC LIMIT 1").get(kind, name, screen)
      : this.db.query("SELECT * FROM secret_requests WHERE kind=? AND name=? ORDER BY created_at DESC LIMIT 1").get(kind, name)) as Row | null;
    return row ? { id: row.id, state: row.state, expires_at: row.state === "pending" ? iso(row.expires_at) : null, detail: row.detail } : null;
  }

  private howToUse(name: string, file: string | null): string {
    return file
      ? `Use it by name without printing it. Programs started from now on can read it from the secrets file: ( . "$CS_SECRETS_FILE" && your-command ), or read one value: "$(. "$CS_SECRETS_FILE"; printf %s "$${name}")". This session's file is ${file}.`
      : `New sessions receive it as the environment variable ${name}. A running session reads it from its $CS_SECRETS_FILE.`;
  }

  async secretStatus(rawName: unknown, caller: { launchId: string | null; screen: string | null } | null): Promise<Record<string, unknown>> {
    let name: string;
    try { name = checkName(rawName); }
    catch (error) { throw new SecretRequestError(error instanceof SecretStoreError ? error.message : "Invalid name."); }
    const found = this.deps.secrets().describe(name);
    const file = caller?.launchId ? this.deps.secretsFile?.(caller.launchId) ?? null : null;
    const environment = caller?.launchId && this.deps.inLaunchEnvironment ? await this.deps.inLaunchEnvironment(caller.launchId, name) : null;
    return {
      name, set: found.set, source: found.source, updated_at: iso(found.updatedAt),
      ...(environment ? { in_launch_environment: found.set ? environment : "missing" } : {}),
      ...(file ? { secrets_file: file, available_in_secrets_file: found.set } : {}),
      request: this.latest("secret", name, caller?.screen ?? null),
      next: found.set ? this.howToUse(name, file)
        : "Not stored. Do not ask for the value in chat: call request_secret with a short reason and give the member the link.",
    };
  }

  async listSecrets(caller: { launchId: string | null } | null): Promise<Record<string, unknown>> {
    const { secrets, sources } = this.deps.secrets().list();
    const names = new Set<string>([...secrets.map(entry => entry.name), ...sources.flatMap(source => source.names)]);
    const entries = [];
    for (const name of [...names].sort()) {
      const found = this.deps.secrets().describe(name);
      const environment = caller?.launchId && this.deps.inLaunchEnvironment ? await this.deps.inLaunchEnvironment(caller.launchId, name) : null;
      entries.push({ name, source: found.source, updated_at: iso(found.updatedAt), ...(environment ? { in_launch_environment: environment } : {}) });
    }
    const file = caller?.launchId ? this.deps.secretsFile?.(caller.launchId) ?? null : null;
    return {
      secrets: entries,
      ...(file ? { secrets_file: file } : {}),
      note: "Names only; values are never returned. Every secret here is in the secrets file now; in_launch_environment says whether this session's own environment also has the current value.",
    };
  }

  connectorStatus(rawName: unknown, caller: { launchId: string | null; screen: string | null } | null): Record<string, unknown> {
    const name = connectorName(rawName);
    const found = this.findConnector(name);
    const request = this.latest("connector", found?.name ?? name, caller?.screen ?? null)
      ?? (found ? this.latest("connector", name, caller?.screen ?? null) : null);
    if (!found) return { name, exists: false, request, next: "Not connected. Call request_connector with its URL and a short reason, and give the member the link." };
    const launch = caller?.launchId ? found.launches.find(entry => entry.launch_id === caller.launchId) : undefined;
    return {
      name: found.name, exists: true, host: found.host, state: found.state, auth_mode: found.auth.mode,
      signed_in: found.auth.mode === "oauth" ? found.auth.oauth?.state === "connected" : found.credential.set,
      granted_tools: found.granted_tools.length, namespace: found.namespace,
      ...(caller?.launchId ? { this_session: { has_connectors_gateway: !!launch, granted: launch?.granted ?? false } } : {}),
      request,
      next: caller?.launchId && !launch
        ? "This session started without the connectors gateway. Ask the member to use Restart with new secrets on this session, then call list_connections."
        : `Granted tools appear as ${found.namespace}__<tool> in the coding_sessions_connectors MCP; call its list_connections.`,
    };
  }
}
