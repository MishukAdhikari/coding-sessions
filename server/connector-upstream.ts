/**
 * A deliberately small MCP client for the connector gateway. It speaks only what a tools
 * gateway needs (negotiation, tools/list, tools/call, cancellation) over every MCP transport,
 * newest first:
 *
 *   - 2026-07-28 stateless Streamable HTTP: no initialize and no sessions; the version and
 *     client details travel in each request's _meta, plus Mcp-Method / Mcp-Name headers.
 *   - 2025-03-26 … 2025-11-25 Streamable HTTP: initialize, optional Mcp-Session-Id.
 *   - 2024-11-05 HTTP+SSE (deprecated): a GET stream names a same-origin endpoint to POST to;
 *     replies arrive on the stream.
 *   - stdio: a local command, newline-delimited JSON-RPC on stdin/stdout.
 *
 * The session layer (negotiation, request/response matching, paging, cancellation, redaction,
 * list_changed notices) is shared; only the wire differs. Every upstream byte is untrusted:
 * bounded size and time, no redirects, and errors classified without echoing upstream text.
 */
import type { Subprocess } from "bun";

export const UPSTREAM_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
/** Stateless protocol revisions (no initialize, version in every request's _meta). */
export const MODERN_VERSIONS = ["2026-07-28"];
/** Spoken only over the deprecated HTTP+SSE transport, which predates Streamable HTTP. */
export const LEGACY_SSE_VERSION = "2024-11-05";
const MAX_BYTES = 4 * 1024 * 1024;
const CLIENT_INFO = { name: "coding-sessions-connector-gateway", version: "1.0.0" };
/** Recognized 2026 JSON-RPC errors: header mismatch, unsupported protocol version. */
const MODERN_ERRORS = new Set([-32020, -32022]);
const NAMED_METHODS: Record<string, "name" | "uri"> = { "tools/call": "name", "prompts/get": "name", "resources/read": "uri" };

export type UpstreamFailure = "auth" | "forbidden" | "unavailable" | "protocol" | "timeout" | "cancelled" | "too_large";
export class UpstreamError extends Error {
  constructor(public readonly kind: UpstreamFailure, message: string) { super(message); this.name = "UpstreamError"; }
}
const MESSAGES: Record<UpstreamFailure, string> = {
  auth: "The connector's credential was rejected. Replace it in Settings.",
  forbidden: "The connector's account is not allowed to do this.",
  unavailable: "The connected service is unavailable.",
  protocol: "The connected service sent an unexpected response.",
  timeout: "The connected service did not answer in time.",
  cancelled: "Request cancelled.",
  too_large: "The connected service's response was too large.",
};
export const UPSTREAM_NOTICES = {
  unsupportedVersion: "The connected service speaks only MCP versions this app does not support.",
  inputRequired: "The connected service asked for more input during the request (input_required), which connectors do not support.",
  crossOrigin: "The server named a message endpoint on another origin, so it was refused.",
  notStarted: "The connector's command could not be started.",
  exited: "The connector's command exited.",
};
const fail = (kind: UpstreamFailure, message?: string): never => { throw new UpstreamError(kind, message ?? MESSAGES[kind]); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export interface UpstreamTool {
  name: string; title?: string; description?: string; inputSchema: Record<string, unknown>;
  /** The server's own annotations, kept only to show the operator. */
  hints?: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean; openWorld?: boolean };
}
export type UpstreamTransport = "streamable-http" | "sse" | "stdio";
export interface UpstreamSession {
  protocolVersion: string; sessionId: string | null; instructions: string;
  serverInfo: { name: string; version: string | null } | null; expiresAt: number;
  /** The wire this session negotiated; with protocolVersion, the era shown to the operator. */
  transport: UpstreamTransport;
}
/** A local command the client spawns, one child per session key. */
export interface StdioCommand {
  /**
   * Resolved just before each spawn: an absolute command path, its arguments, an existing
   * working folder and the child's whole environment. A local failure (a missing secret or
   * command) is thrown as the caller's own error class and passed through unchanged.
   */
  prepare: (signal: AbortSignal) => Promise<{ command: string; args: string[]; cwd: string; env: Record<string, string> }>;
}
export interface UpstreamOptions {
  /** An HTTP(S) server. Exactly one of url and stdio. */
  url?: URL;
  stdio?: StdioCommand;
  /**
   * The credential for one request, resolved just before it is sent (it may refresh first).
   * null sends no Authorization header (a server that needs none).
   */
  credential: (signal: AbortSignal) => string | null | Promise<string | null>;
  /** Operator-set extra HTTP headers (already validated), resolved per request. Their values are scrubbed like tokens. */
  headers?: (signal: AbortSignal) => Record<string, string> | Promise<Record<string, string>>;
  /** Other secrets to scrub from responses besides the ones actually sent (recent tokens). */
  secrets?: () => string[];
  /** The resource rejected exactly this credential (HTTP 401). */
  onAuthRejected?: (credential: string) => void;
  fetch?: typeof fetch;
  /** Transport for a legacy SSE message endpoint, which may carry a query. Defaults to fetch. */
  endpointFetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  onToolsChanged?: () => void;
  /** A session unused this long is closed (a stdio child is stopped). Default 10 minutes. */
  idleMs?: number;
  /** How long a stdio server has to answer server/discover before it is treated as legacy. Default 5 s. */
  probeMs?: number;
}
interface Call { signal?: AbortSignal; timeoutMs?: number }
interface Posted { response: Response; signal: AbortSignal; release: () => void; sent: string[] }
type Era = "modern" | "streamable" | "sse" | "stdio-modern" | "stdio-legacy";
interface Channel {
  readonly session: UpstreamSession;
  readonly closed: boolean;
  request(method: string, params: Record<string, unknown>, call: Call): Promise<unknown>;
  close(): void;
}

/** Every credential this app accepts is at least this long, so every one is covered by redact. */
export const MIN_SECRET_LENGTH = 8;
/**
 * Replaces every occurrence of each secret in every string value and object key of a parsed
 * upstream message, so a server that reflects a token in serverInfo, tool lists or results never
 * hands it on. Works on parsed values, so tokens containing quotes or backslashes are matched
 * exactly. This guards against raw reflection, not against a server deliberately encoding what
 * it received.
 */
export function redact<T>(value: T, secrets: Array<string | null | undefined>): T {
  const list = [...new Set(secrets.filter((s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH))]
    .sort((a, b) => b.length - a.length);
  if (!list.length) return value;
  const clean = (text: string) => list.reduce((out, secret) => out.includes(secret) ? out.split(secret).join("[redacted]") : out, text);
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return clean(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, child]) => [clean(key), walk(child)]));
    return node;
  };
  return walk(value) as T;
}
/** The request was certainly not processed (session gone, version refused): open a new session and send once more. */
const SESSION_EXPIRED = "session-expired";
const RENEGOTIATE = "renegotiate";
/** Wait for a shared promise, abandoning only this waiter on its own cancellation. */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new UpstreamError("cancelled", MESSAGES.cancelled));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new UpstreamError("cancelled", MESSAGES.cancelled));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
const reasonKind = (signal: AbortSignal, fallback: UpstreamFailure): UpstreamFailure =>
  signal.aborted && signal.reason instanceof UpstreamError ? signal.reason.kind : fallback;
/** Errors a session layer passes through unchanged: our own classes and local failures. */
const local = (error: unknown) => !(error instanceof Error) || error.name === "ConnectorError" || error.name === "DestinationError"
  || error instanceof UpstreamError || error instanceof UpstreamRpcError;

const label = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value.trim().slice(0, max) : null;
function serverInfo(value: unknown): UpstreamSession["serverInfo"] {
  if (!object(value)) return null;
  const name = label(value.name, 80);
  return name ? { name, version: label(value.version, 40) } : null;
}
function hints(value: Record<string, unknown>): NonNullable<UpstreamTool["hints"]> {
  const flag = (key: string) => typeof value[key] === "boolean" ? value[key] as boolean : undefined;
  const out = { readOnly: flag("readOnlyHint"), destructive: flag("destructiveHint"), idempotent: flag("idempotentHint"), openWorld: flag("openWorldHint") };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}
const instructions = (value: unknown) => typeof value === "string" ? value.slice(0, 16384) : "";

/** A name listed more than once (e.g. across pages) is ambiguous: drop every copy. */
function unique(tools: UpstreamTool[]): UpstreamTool[] {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return tools.filter(tool => counts.get(tool.name) === 1);
}

/** The three _meta keys every 2026 request carries. */
const modernMeta = (version: string) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
});
function modernParams(params: Record<string, unknown>, version: string): Record<string, unknown> {
  return { ...params, _meta: { ...(object(params._meta) ? params._meta : {}), ...modernMeta(version) } };
}
/** A header value that is not plain visible ASCII is sent base64-encoded, as the 2026 spec defines. */
export const mcpHeaderValue = (value: string): string =>
  /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !value.startsWith("=?") ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
function modernHeaders(method: string, params: Record<string, unknown>, version: string): Record<string, string> {
  const headers: Record<string, string> = { "mcp-protocol-version": version, "mcp-method": method };
  const key = NAMED_METHODS[method];
  const name = key ? params[key] : undefined;
  if (typeof name === "string") headers["mcp-name"] = mcpHeaderValue(name);
  return headers;
}

/**
 * Accepts one response message for `id`: scrubbed of secrets before anything reads it, then
 * checked. Upstream error text can echo request data, so only the numeric code crosses this
 * boundary. A 2026 result that is not complete (input_required) is refused: connectors answer
 * no server-to-client requests.
 */
function settle(raw: Record<string, unknown>, id: number, secrets: Array<string | null | undefined>): unknown {
  const message = redact(raw, secrets);
  if (message.jsonrpc !== "2.0" || message.id !== id) fail("protocol");
  if (object(message.error)) {
    throw new UpstreamRpcError(typeof message.error.code === "number" && Number.isSafeInteger(message.error.code) ? message.error.code : -32603);
  }
  if (!Object.hasOwn(message, "result")) fail("protocol");
  const result = message.result;
  if (object(result) && result.resultType !== undefined && result.resultType !== "complete") {
    fail("protocol", result.resultType === "input_required" ? UPSTREAM_NOTICES.inputRequired : undefined);
  }
  return result;
}

/**
 * What a recognized "unsupported version" error leaves: a 2025 version to initialize with
 * (null when there is none). A modern server that supports nothing we speak fails clearly.
 */
function supportedFallback(error: Record<string, unknown>): string {
  const supported = object(error.data) && Array.isArray(error.data.supported) ? error.data.supported.filter((v): v is string => typeof v === "string") : [];
  const legacy = UPSTREAM_VERSIONS.find(version => supported.includes(version));
  return legacy ?? fail("protocol", UPSTREAM_NOTICES.unsupportedVersion);
}

/** Reads a body with a hard byte cap; never buffers more than the cap. */
async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) break;
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); fail("too_large"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Incremental server-sent-events parser. One event may hold at most MAX_BYTES; event:, data:
 * and comments are honoured, id: and retry: carry nothing this gateway needs.
 */
class SseParser {
  private buffer = "";
  private data: string[] = [];
  private size = 0;
  private type = "";
  private readonly decoder = new TextDecoder();
  constructor(private readonly onEvent: (type: string, data: string) => void) {}
  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) break;
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (line === "") {
        const type = this.type || "message";
        const data = this.data;
        this.type = ""; this.data = []; this.size = 0;
        if (data.length) this.onEvent(type, data.join("\n"));
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        this.size += value.length;
        this.data.push(value);
      } else if (line.startsWith("event:")) this.type = line.slice(6).trim();
    }
    if (this.size + this.buffer.length > MAX_BYTES) fail("too_large");
  }
}

/** Consume an SSE response until the response for `id` arrives; notifications along the way are inspected, never forwarded. */
async function sseResponse(response: Response, id: number, signal: AbortSignal, onMessage: (value: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) fail("protocol");
  let found: Record<string, unknown> | null = null;
  const parser = new SseParser((_type, data) => {
    if (found) return;
    let value: unknown;
    try { value = JSON.parse(data); } catch { fail("protocol"); }
    if (!object(value)) fail("protocol");
    const message = value as Record<string, unknown>;
    if (message.id === id && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) found = message;
    else onMessage(message);
  });
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) { await reader!.cancel().catch(() => {}); fail("too_large"); }
      parser.push(chunk.value);
      if (found) { await reader!.cancel().catch(() => {}); return found; }
      if (signal.aborted) break;
    }
  } finally { try { reader!.releaseLock(); } catch {} }
  return signal.aborted ? fail("cancelled") : fail("protocol");
}

/** Children of every client, stopped hard if this process exits without closing them. */
const children = new Set<Subprocess>();
let exitHook = false;
function track(child: Subprocess): void {
  children.add(child);
  void child.exited.then(() => children.delete(child), () => children.delete(child));
  if (!exitHook) {
    exitHook = true;
    const killAll = () => { for (const entry of children) { try { entry.kill("SIGKILL"); } catch {} } };
    process.once("exit", killAll);
    // A signal that ends the service ends its local connectors too, then terminates as it would have.
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      const handler = () => {
        killAll();
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      };
      process.once(signal, handler);
    }
  }
}

/**
 * Shared state of a long-lived wire (legacy SSE stream, stdio child): requests by id,
 * notices, server-to-client requests answered with "not supported", and shutdown that
 * rejects everything still waiting.
 */
abstract class StreamChannel implements Channel {
  session!: UpstreamSession;
  closed = false;
  protected failure: UpstreamError = new UpstreamError("unavailable", MESSAGES.unavailable);
  private readonly pending = new Map<number, { resolve: (message: Record<string, unknown>) => void; reject: (error: unknown) => void }>();
  /** Secrets sent on this wire, scrubbed from everything it receives. */
  protected readonly sent = new Set<string>();
  protected modern: string | null = null;
  constructor(protected readonly client: UpstreamClient) {}

  /** Sends one JSON-RPC message (request, reply or notification). */
  protected abstract write(message: Record<string, unknown>, call: Call): Promise<void>;
  protected abstract stop(): void;

  protected secrets(): string[] { return [...this.sent, ...this.client.extraSecrets()]; }

  protected dispatch(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id === "number" && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) && !Object.hasOwn(message, "method")) {
      const waiter = this.pending.get(id);
      if (waiter) { this.pending.delete(id); waiter.resolve(message); }
      return;
    }
    if (typeof message.method !== "string") return;
    if (id !== undefined && id !== null && (typeof id === "string" || typeof id === "number")) {
      // Server-to-client requests: ping is answered, everything else (sampling, roots, elicitation) is not offered.
      const reply = message.method === "ping" ? { jsonrpc: "2.0", id, result: {} } : { jsonrpc: "2.0", id, error: { code: -32601, message: "Not supported by this client." } };
      void this.write(reply, { timeoutMs: 5000 }).catch(() => {});
      return;
    }
    this.client.notice(redact(message, this.secrets()));
  }

  /** Ends the wire: every waiting request fails with `error`; later requests reopen a session. */
  protected shutdown(error: UpstreamError): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const [id, waiter] of this.pending) { this.pending.delete(id); waiter.reject(error); }
    this.stop();
  }
  close(): void { this.shutdown(new UpstreamError("cancelled", MESSAGES.cancelled)); }

  /** Sends a request and waits for its reply, bounded by the call's time and cancellation. */
  async exchange(method: string, params: Record<string, unknown>, call: Call, options: { cancel?: boolean } = {}): Promise<{ id: number; message: Record<string, unknown> }> {
    if (this.closed) throw new UpstreamError("unavailable", SESSION_EXPIRED);
    const id = this.client.next();
    const timeoutMs = call.timeoutMs ?? this.client.defaultTimeout;
    let cleanup = () => {};
    const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new UpstreamError("timeout", MESSAGES.timeout)); }, timeoutMs);
      const onAbort = () => { this.pending.delete(id); reject(new UpstreamError("cancelled", MESSAGES.cancelled)); };
      call.signal?.addEventListener("abort", onAbort, { once: true });
      cleanup = () => { clearTimeout(timer); call.signal?.removeEventListener("abort", onAbort); };
      this.pending.set(id, { resolve, reject });
      if (call.signal?.aborted) onAbort();
    });
    reply.catch(() => {});
    try {
      if (call.signal?.aborted) fail("cancelled");
      await this.write({ jsonrpc: "2.0", id, method, params: this.modern ? modernParams(params, this.modern) : params }, call);
      return { id, message: await reply };
    } catch (error) {
      this.pending.delete(id);
      if (options.cancel !== false && error instanceof UpstreamError && (error.kind === "cancelled" || error.kind === "timeout") && !this.closed) {
        void this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Cancelled by the client." } }, { timeoutMs: 5000 }).catch(() => {});
      }
      throw error;
    } finally { cleanup(); }
  }

  async request(method: string, params: Record<string, unknown>, call: Call): Promise<unknown> {
    const { id, message } = await this.exchange(method, params, call);
    return settle(message, id, this.secrets());
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    try { await this.write({ jsonrpc: "2.0", method, params }, { timeoutMs: 5000 }); } catch { /* best effort */ }
  }

  /** Legacy handshake: initialize, then notifications/initialized. */
  async initialize(protocolVersion: string, accepted: string[], transport: UpstreamTransport, call: Call): Promise<void> {
    const result = await this.request("initialize", { protocolVersion, capabilities: {}, clientInfo: CLIENT_INFO }, call);
    if (!object(result) || typeof result.protocolVersion !== "string" || !accepted.includes(result.protocolVersion)) fail("protocol");
    const value = result as Record<string, unknown>;
    if (!object(value.capabilities) || !object(value.capabilities.tools)) fail("protocol");
    this.session = { protocolVersion: value.protocolVersion as string, sessionId: null, instructions: instructions(value.instructions),
      serverInfo: serverInfo(value.serverInfo), expiresAt: this.client.clock() + 24 * 3600_000, transport };
    await this.notify("notifications/initialized", {});
  }
}

/** Legacy HTTP+SSE: replies and notices arrive on the GET stream; messages are POSTed to the endpoint it names. */
class SseChannel extends StreamChannel {
  endpoint: URL | null = null;
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  constructor(client: UpstreamClient, private readonly base: URL, private readonly abort: AbortController) {
    super(client);
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
  }
  start(response: Response, sent: string[]): void {
    for (const value of sent) this.sent.add(value);
    const reader = response.body?.getReader();
    if (!reader) { this.shutdown(new UpstreamError("protocol", MESSAGES.protocol)); return; }
    const parser = new SseParser((type, data) => this.event(type, data));
    void (async () => {
      let error: UpstreamError = new UpstreamError("unavailable", MESSAGES.unavailable);
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          parser.push(chunk.value);
          if (this.closed) break;
        }
      } catch (caught) { if (caught instanceof UpstreamError) error = caught; }
      finally { reader.cancel().catch(() => {}); }
      this.shutdown(error);
    })();
  }
  private event(type: string, data: string): void {
    if (type === "endpoint") {
      if (this.endpoint) return;
      let target: URL;
      try { target = new URL(data.trim(), this.base); } catch { this.shutdown(new UpstreamError("protocol", MESSAGES.protocol)); return; }
      // SSRF guard: the endpoint must stay on the origin the operator entered (and is vetted again when used).
      if (target.origin !== this.base.origin || target.username || target.password || !/^https?:$/.test(target.protocol)) {
        this.shutdown(new UpstreamError("protocol", UPSTREAM_NOTICES.crossOrigin)); return;
      }
      target.hash = "";
      this.endpoint = target;
      this.resolveReady();
      return;
    }
    if (type !== "message" || !this.endpoint) return;
    let value: unknown;
    try { value = JSON.parse(data); } catch { return; }
    if (object(value)) this.dispatch(value);
  }
  waitReady(timeoutMs: number): Promise<void> {
    const timer = setTimeout(() => this.shutdown(new UpstreamError("timeout", MESSAGES.timeout)), timeoutMs);
    return this.ready.finally(() => clearTimeout(timer));
  }
  protected override shutdown(error: UpstreamError): void {
    if (!this.closed) this.rejectReady(error);
    super.shutdown(error);
  }
  protected stop(): void { this.abort.abort(new UpstreamError("cancelled", MESSAGES.cancelled)); }
  protected async write(message: Record<string, unknown>, call: Call): Promise<void> {
    if (this.closed || !this.endpoint) throw new UpstreamError("unavailable", SESSION_EXPIRED);
    const { response, release, sent } = await this.client.post(this.endpoint, message, {}, call, "endpoint");
    for (const value of sent) this.sent.add(value);
    try {
      if (response.status === 401) { this.client.rejected(sent); fail("auth"); }
      if (response.status === 403) fail("forbidden");
      // The server no longer knows this session: nothing was processed.
      if (response.status === 404) { this.shutdown(new UpstreamError("unavailable", MESSAGES.unavailable)); throw new UpstreamError("unavailable", SESSION_EXPIRED); }
      if (!response.ok) fail("unavailable");
    } finally { release(); response.body?.cancel().catch(() => {}); }
  }
}

/** A local command speaking newline-delimited JSON-RPC. stderr is drained and discarded. */
class StdioChannel extends StreamChannel {
  private stopping = false;
  constructor(client: UpstreamClient, private readonly child: Subprocess<"pipe", "pipe", "pipe">, secrets: string[]) {
    super(client);
    for (const value of secrets) this.sent.add(value);
    void this.pumpStdout();
    void this.drainStderr();
    void child.exited.then(() => this.shutdown(new UpstreamError("unavailable", UPSTREAM_NOTICES.exited)), () => {});
  }
  private async pumpStdout(): Promise<void> {
    const reader = this.child.stdout.getReader();
    let parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        let bytes = chunk.value;
        for (;;) {
          const end = bytes.indexOf(10);
          if (end < 0) break;
          parts.push(bytes.subarray(0, end));
          const line = Buffer.concat(parts).toString("utf8").replace(/\r$/, "");
          parts = []; size = 0;
          bytes = bytes.subarray(end + 1);
          this.line(line);
        }
        size += bytes.byteLength;
        if (size > MAX_BYTES) { this.shutdown(new UpstreamError("too_large", MESSAGES.too_large)); break; }
        if (bytes.byteLength) parts.push(bytes);
        if (this.closed) break;
      }
    } catch { /* the child went away */ }
    finally { reader.cancel().catch(() => {}); }
    this.shutdown(new UpstreamError("unavailable", UPSTREAM_NOTICES.exited));
  }
  private line(text: string): void {
    if (!text.trim()) return;
    let value: unknown;
    // Anything but JSON-RPC on stdout is a server bug; it is skipped, never echoed.
    try { value = JSON.parse(text); } catch { return; }
    if (object(value)) this.dispatch(value);
  }
  private async drainStderr(): Promise<void> {
    const reader = this.child.stderr.getReader();
    try { for (;;) { if ((await reader.read()).done) break; } } catch {}
  }
  protected async write(message: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new UpstreamError("unavailable", SESSION_EXPIRED);
    try { this.child.stdin.write(JSON.stringify(message) + "\n"); this.child.stdin.flush(); }
    catch { this.shutdown(new UpstreamError("unavailable", UPSTREAM_NOTICES.exited)); throw new UpstreamError("unavailable", UPSTREAM_NOTICES.exited); }
  }
  /** Close stdin, then SIGTERM after 2 s, then SIGKILL after 2 s more. */
  protected stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    const child = this.child;
    try { child.stdin.end(); } catch {}
    const exited = (ms: number) => Promise.race([child.exited.then(() => true, () => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms).unref?.())]);
    void (async () => {
      if (await exited(2000)) return;
      try { child.kill("SIGTERM"); } catch {}
      if (await exited(2000)) return;
      try { child.kill("SIGKILL"); } catch {}
    })();
  }
  /**
   * Probe with server/discover: a DiscoverResult means 2026 (no initialize). A recognized
   * unsupported-version error names what the server speaks. Anything else, or silence within
   * probeMs, means a legacy server: initialize as before.
   */
  async negotiate(cached: Era | null, timeoutMs: number, probeMs: number): Promise<Era> {
    const version = MODERN_VERSIONS[0]!;
    let legacy: string = UPSTREAM_VERSIONS[0]!;
    if (cached !== "stdio-legacy") {
      let reply: { id: number; message: Record<string, unknown> } | null = null;
      try {
        this.modern = version;
        reply = await this.exchange("server/discover", {}, { timeoutMs: Math.min(probeMs, timeoutMs) }, { cancel: false });
      } catch (error) {
        if (!(error instanceof UpstreamError) || error.kind !== "timeout" || this.closed) throw error;
      } finally { this.modern = null; }
      const message = reply ? redact(reply.message, this.secrets()) : null;
      if (message && object(message.error) && message.error.code === -32022) legacy = supportedFallback(message.error);
      else if (message && object(message.result)) {
        const session = discovered(message.result, version, "stdio", this.client.clock());
        if (session) { this.modern = version; this.session = session; return "stdio-modern"; }
      }
    }
    await this.initialize(legacy, UPSTREAM_VERSIONS, "stdio", { timeoutMs });
    return "stdio-legacy";
  }
}

/** A 2026 DiscoverResult for `version`, or null when it is not one. */
function discovered(result: Record<string, unknown>, version: string, transport: UpstreamTransport, now: number): UpstreamSession | null {
  if (!Array.isArray(result.supportedVersions)) return null;
  if (!result.supportedVersions.includes(version)) {
    supportedFallback({ data: { supported: result.supportedVersions } });
    return null;
  }
  if (!object(result.capabilities) || !object(result.capabilities.tools)) fail("protocol");
  const meta = object(result._meta) ? result._meta : {};
  const ttl = typeof result.ttlMs === "number" && Number.isFinite(result.ttlMs) ? Math.min(Math.max(result.ttlMs, 60_000), 30 * 60_000) : 30 * 60_000;
  return { protocolVersion: version, sessionId: null, instructions: instructions(result.instructions),
    serverInfo: serverInfo(meta["io.modelcontextprotocol/serverInfo"] ?? result.serverInfo), expiresAt: now + ttl, transport };
}

export class UpstreamClient {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly sessions = new Map<string, Promise<Channel>>();
  private readonly idle = new Map<string, ReturnType<typeof setTimeout>>();
  private sequence = 0;
  /** The transport and era that last worked, so later sessions skip probes that failed. */
  private era: Era | null = null;
  constructor(private readonly options: UpstreamOptions) {
    if (!!options.url === !!options.stdio) throw new Error("An upstream needs exactly one of url or stdio.");
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private readonly lifetime = new AbortController();
  /** Forget a cached session (e.g. before a fresh settings check); renegotiate also forgets the transport that worked. */
  reset(key?: string, options: { renegotiate?: boolean } = {}): void {
    if (options.renegotiate) this.era = null;
    for (const entry of key === undefined ? [...this.sessions.keys()] : [key]) this.drop(entry);
  }
  /** Permanently stop: in-flight requests (including a shared handshake) abort, children stop, and new requests fail before sending. */
  close(): void { this.reset(); this.lifetime.abort(new UpstreamError("cancelled", MESSAGES.cancelled)); }

  /* ---------- shared by the wires ---------- */

  next(): number { return ++this.sequence; }
  clock(): number { return this.now(); }
  get defaultTimeout(): number { return this.options.timeoutMs ?? 120_000; }
  extraSecrets(): string[] { return this.options.secrets?.() ?? []; }
  notice(message: Record<string, unknown>): void {
    if (message.method === "notifications/tools/list_changed") this.options.onToolsChanged?.();
  }
  rejected(sent: string[]): void { if (sent[0]) this.options.onAuthRejected?.(sent[0]); }

  /** One HTTP POST of a JSON-RPC message, with credential, extra headers and the call's time and cancellation. */
  async post(target: URL, body: Record<string, unknown>, extra: Record<string, string>, call: Call, role: "server" | "endpoint" = "server"): Promise<Posted> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new UpstreamError("timeout", MESSAGES.timeout)), call.timeoutMs ?? this.defaultTimeout);
    const onAbort = () => abort.abort(new UpstreamError("cancelled", MESSAGES.cancelled));
    call.signal?.addEventListener("abort", onAbort, { once: true });
    this.lifetime.signal.addEventListener("abort", onAbort, { once: true });
    if (call.signal?.aborted || this.lifetime.signal.aborted) onAbort();
    const release = () => { clearTimeout(timeout); call.signal?.removeEventListener("abort", onAbort); this.lifetime.signal.removeEventListener("abort", onAbort); };
    try {
      if (abort.signal.aborted) throw abort.signal.reason;
      const { headers, sent } = await this.headers(abort.signal);
      // Cancelled or closed while the credential was being prepared: send nothing.
      if (abort.signal.aborted) throw abort.signal.reason;
      Object.assign(headers, { "content-type": "application/json", accept: "application/json, text/event-stream" }, extra);
      const fetcher = role === "endpoint" ? this.options.endpointFetch ?? this.fetch : this.fetch;
      const response = await fetcher(target, { method: "POST", redirect: "error", headers, body: JSON.stringify(body), signal: abort.signal });
      return { response, signal: abort.signal, release, sent };
    } catch (error) {
      release();
      // A local failure (e.g. the credential cannot be opened) keeps its own class.
      if (local(error)) throw error;
      return fail(reasonKind(abort.signal, "unavailable"));
    }
  }

  /** Extra headers first, then the credential: what this app sets always wins. sent[0] is the credential (or ""). */
  private async headers(signal: AbortSignal): Promise<{ headers: Record<string, string>; sent: string[] }> {
    const credential = await this.options.credential(signal);
    const custom = this.options.headers ? await this.options.headers(signal) : {};
    const headers: Record<string, string> = { ...custom };
    if (credential) headers.authorization = `Bearer ${credential}`;
    return { headers, sent: [credential ?? "", ...Object.values(custom)] };
  }

  /**
   * POST one request and read its reply message, whatever the status: callers classify.
   * 401 and 403 mean the same in every era and fail here.
   */
  private async exchange(body: Record<string, unknown>, id: number, extra: Record<string, string>, call: Call): Promise<{ status: number; message: Record<string, unknown> | null; sessionId: string | null; sent: string[] }> {
    const { response, signal, release, sent } = await this.post(this.options.url!, body, extra, call);
    try {
      if (response.status === 401) { this.rejected(sent); fail("auth"); }
      if (response.status === 403) fail("forbidden");
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      let message: Record<string, unknown> | null = null;
      try {
        if (type === "text/event-stream" && response.ok) {
          message = await sseResponse(response, id, signal, value => this.notice(redact(value, [...sent, ...this.extraSecrets()])));
        } else if (type === "application/json" && (response.ok || response.status === 400)) {
          // Only a 400's body can matter (a recognized 2026 error); other failures are classified by status alone.
          const text = await boundedText(response, signal);
          let parsed: unknown = null;
          try { parsed = JSON.parse(text); } catch { if (response.ok) fail("protocol"); }
          if (object(parsed)) message = parsed;
          else if (response.ok) fail("protocol");
        }
      } catch (error) {
        if (error instanceof UpstreamError && !signal.aborted) throw error;
        return fail(reasonKind(signal, "protocol"));
      }
      if (signal.aborted) fail(reasonKind(signal, "cancelled"));
      return { status: response.status, message, sessionId: response.headers.get("mcp-session-id"), sent };
    } finally {
      release();
      response.body?.cancel().catch(() => {});
    }
  }
  private secretsFor(sent: string[]): string[] { return [...sent, ...this.extraSecrets()]; }

  /* ---------- 2026-07-28 stateless Streamable HTTP ---------- */

  /** server/discover: the session when the server is modern, null to fall back to initialize. */
  private async discover(call: Call): Promise<UpstreamSession | null> {
    const version = MODERN_VERSIONS[0]!;
    const id = this.next();
    const { status, message: raw, sent } = await this.exchange({ jsonrpc: "2.0", id, method: "server/discover", params: modernParams({}, version) },
      id, modernHeaders("server/discover", {}, version), call);
    const message = raw ? redact(raw, this.secretsFor(sent)) : null;
    const error = message && object(message.error) ? message.error : null;
    // A recognized modern error: this is a 2026 server. Use a 2025 version it lists, or fail clearly; never guess.
    if (error && (status === 400 || (status >= 200 && status < 300)) && MODERN_ERRORS.has(error.code as number)) {
      if (error.code === -32022) { supportedFallback(error); return null; }
      return fail("protocol");
    }
    if (status >= 200 && status < 300 && message && message.jsonrpc === "2.0" && message.id === id && object(message.result)) {
      return discovered(message.result, version, "streamable-http", this.now());
    }
    // 400 with an empty or unrecognized body, 404, 405, -32601 or anything else: an older server.
    return null;
  }

  private modernChannel(session: UpstreamSession): Channel {
    let closed = false;
    return {
      session, get closed() { return closed; }, close: () => { closed = true; },
      request: async (method, params, call) => {
        if (closed) throw new UpstreamError("unavailable", SESSION_EXPIRED);
        const id = this.next();
        // Cancellation over 2026 HTTP is closing the response stream: the call's signal aborts the fetch.
        const { status, message, sent } = await this.exchange({ jsonrpc: "2.0", id, method, params: modernParams(params, session.protocolVersion) },
          id, modernHeaders(method, params, session.protocolVersion), call);
        if (status === 400 && message && object(message.error) && MODERN_ERRORS.has(message.error.code as number)) {
          // The server refused our version or headers before processing: negotiate again.
          throw new UpstreamError("unavailable", RENEGOTIATE);
        }
        if (status < 200 || status >= 300) fail("unavailable");
        if (!message) fail("protocol");
        return settle(message!, id, this.secretsFor(sent));
      },
    };
  }

  /* ---------- 2025 Streamable HTTP ---------- */

  /** initialize; "sse" when the server answers 400, 404 or 405 (the spec's cue to try HTTP+SSE). */
  private async initialize(call: Call): Promise<Channel | "sse"> {
    const id = this.next();
    const { status, message, sessionId, sent } = await this.exchange({ jsonrpc: "2.0", id, method: "initialize", params: {
      protocolVersion: UPSTREAM_VERSIONS[0], capabilities: {}, clientInfo: CLIENT_INFO,
    } }, id, {}, call);
    if (status === 400 || status === 404 || status === 405) return "sse";
    if (status < 200 || status >= 300) fail("unavailable");
    if (!message) fail("protocol");
    const result = settle(message!, id, this.secretsFor(sent));
    if (!object(result) || typeof result.protocolVersion !== "string" || !UPSTREAM_VERSIONS.includes(result.protocolVersion)) fail("protocol");
    const value = result as Record<string, unknown>;
    if (!object(value.capabilities) || !object(value.capabilities.tools)) fail("protocol");
    const session: UpstreamSession = {
      protocolVersion: value.protocolVersion as string,
      sessionId: sessionId && /^[\x21-\x7e]{1,256}$/.test(sessionId) ? sessionId : null,
      instructions: instructions(value.instructions),
      serverInfo: serverInfo(value.serverInfo),
      expiresAt: this.now() + 30 * 60_000,
      transport: "streamable-http",
    };
    const extra = (): Record<string, string> => ({ "mcp-protocol-version": session.protocolVersion, ...(session.sessionId ? { "mcp-session-id": session.sessionId } : {}) });
    const notify = async (method: string, params: Record<string, unknown>) => {
      try {
        const { response, release } = await this.post(this.options.url!, { jsonrpc: "2.0", method, params }, extra(), { timeoutMs: 5000 });
        release();
        await response.body?.cancel().catch(() => {});
      } catch { /* Best effort: a notification has no reply to wait for. */ }
    };
    await notify("notifications/initialized", {});
    let closed = false;
    return {
      session, get closed() { return closed; }, close: () => { closed = true; },
      request: async (method, params, call) => {
        const id = this.next();
        try {
          const { status, message, sent } = await this.exchange({ jsonrpc: "2.0", id, method, params }, id, extra(), call);
          if (status === 404 && session.sessionId) throw new UpstreamError("unavailable", SESSION_EXPIRED);
          if (status < 200 || status >= 300) fail("unavailable");
          if (!message) fail("protocol");
          return settle(message!, id, this.secretsFor(sent));
        } catch (error) {
          if (error instanceof UpstreamError && error.kind === "cancelled") void notify("notifications/cancelled", { requestId: id, reason: "Cancelled by the client." });
          throw error;
        }
      },
    };
  }

  /* ---------- 2024-11-05 HTTP+SSE (deprecated) ---------- */

  private async openSse(timeoutMs: number): Promise<Channel> {
    const url = this.options.url!;
    const abort = new AbortController();
    const stop = () => abort.abort(new UpstreamError("cancelled", MESSAGES.cancelled));
    this.lifetime.signal.addEventListener("abort", stop, { once: true });
    abort.signal.addEventListener("abort", () => this.lifetime.signal.removeEventListener("abort", stop), { once: true });
    if (this.lifetime.signal.aborted) stop();
    const timer = setTimeout(() => abort.abort(new UpstreamError("timeout", MESSAGES.timeout)), timeoutMs);
    let response: Response;
    let sent: string[];
    try {
      if (abort.signal.aborted) throw abort.signal.reason;
      const prepared = await this.headers(abort.signal);
      sent = prepared.sent;
      if (abort.signal.aborted) throw abort.signal.reason;
      response = await this.fetch(url, { method: "GET", redirect: "error", headers: { ...prepared.headers, accept: "text/event-stream" }, signal: abort.signal });
    } catch (error) {
      clearTimeout(timer);
      abort.abort();
      if (local(error)) throw error;
      return fail(reasonKind(abort.signal, "unavailable"));
    }
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (response.status === 401 || response.status === 403 || !response.ok || type !== "text/event-stream") {
      clearTimeout(timer);
      response.body?.cancel().catch(() => {});
      abort.abort();
      if (response.status === 401) { this.rejected(sent); fail("auth"); }
      if (response.status === 403) fail("forbidden");
      return fail("unavailable");
    }
    const channel = new SseChannel(this, url, abort);
    channel.start(response, sent);
    try {
      await channel.waitReady(timeoutMs);
      clearTimeout(timer);
      await channel.initialize(LEGACY_SSE_VERSION, [LEGACY_SSE_VERSION, ...UPSTREAM_VERSIONS], "sse", { timeoutMs });
      return channel;
    } catch (error) {
      clearTimeout(timer);
      channel.close();
      throw error;
    }
  }

  /* ---------- stdio ---------- */

  private async openStdio(timeoutMs: number): Promise<Channel> {
    const spec = await this.options.stdio!.prepare(this.lifetime.signal);
    const env = spec.env;
    if (this.lifetime.signal.aborted) fail("cancelled");
    let child: Subprocess<"pipe", "pipe", "pipe">;
    try { child = Bun.spawn([spec.command, ...spec.args], { cwd: spec.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }); }
    catch { return fail("unavailable", UPSTREAM_NOTICES.notStarted); }
    track(child);
    // Values passed in the environment are secrets too: never hand them on if the server prints them.
    const secrets = Object.entries(env).filter(([name]) => !["PATH", "HOME", "LANG", "TMPDIR"].includes(name)).map(([, value]) => value);
    const channel = new StdioChannel(this, child, secrets);
    try {
      this.era = await channel.negotiate(this.era, timeoutMs, this.options.probeMs ?? 5000);
      return channel;
    } catch (error) { channel.close(); throw error; }
  }

  /* ---------- the session layer ---------- */

  private async negotiate(timeoutMs: number): Promise<Channel> {
    const call = { timeoutMs };
    const modern = await this.discover(call);
    if (modern) { this.era = "modern"; return this.modernChannel(modern); }
    const streamable = await this.initialize(call);
    if (streamable !== "sse") { this.era = "streamable"; return streamable; }
    const sse = await this.openSse(timeoutMs);
    this.era = "sse";
    return sse;
  }

  /** Opens a session on the transport that worked last, else negotiates; a failure on the remembered path negotiates once more. */
  private async open(timeoutMs: number): Promise<Channel> {
    if (this.lifetime.signal.aborted) fail("cancelled");
    if (this.options.stdio) return this.openStdio(timeoutMs);
    const cached = this.era;
    if (cached === "streamable" || cached === "sse" || cached === "modern") {
      try {
        if (cached === "modern") {
          const session = await this.discover({ timeoutMs });
          if (session) return this.modernChannel(session);
        } else if (cached === "streamable") {
          const channel = await this.initialize({ timeoutMs });
          if (channel !== "sse") return channel;
        } else return await this.openSse(timeoutMs);
      } catch (error) {
        const retry = error instanceof UpstreamRpcError || (error instanceof UpstreamError && (error.kind === "protocol" || error.kind === "unavailable"));
        if (!retry) throw error;
      }
      this.era = null;
    }
    return this.negotiate(timeoutMs);
  }

  private drop(key: string, which?: Promise<Channel>): void {
    const entry = this.sessions.get(key);
    clearTimeout(this.idle.get(key)); this.idle.delete(key);
    if (!entry || (which && entry !== which)) return;
    this.sessions.delete(key);
    entry.then(channel => channel.close(), () => {});
  }
  /** Closes a session (stopping a stdio child) once it has gone unused for idleMs. */
  private arm(key: string, entry: Promise<Channel>): void {
    clearTimeout(this.idle.get(key));
    const timer = setTimeout(() => this.drop(key, entry), this.options.idleMs ?? 10 * 60_000);
    timer.unref?.();
    this.idle.set(key, timer);
  }

  private channel(key: string, call: Call, fresh = false): Promise<Channel> {
    const cached = this.sessions.get(key);
    if (cached) {
      return waitFor(cached, call.signal).then(channel => {
        if (fresh || (!channel.closed && channel.session.expiresAt > this.now())) { this.arm(key, cached); return channel; }
        this.drop(key, cached);
        return this.channel(key, call, true);
      });
    }
    // Shared by every waiter for this key, so it runs on its own timeout; each waiter cancels only its own wait.
    const created = this.open(Math.min(call.timeoutMs ?? 20_000, 20_000));
    this.sessions.set(key, created);
    created.then(() => { if (this.sessions.get(key) === created) this.arm(key, created); },
      () => { if (this.sessions.get(key) === created) this.sessions.delete(key); });
    if (this.lifetime.signal.aborted) created.then(channel => channel.close(), () => {});
    return waitFor(created, call.signal);
  }

  /** One upstream session per key (a launch, or settings checks), so transport state never crosses launches. */
  session(key: string, call: Call = {}): Promise<UpstreamSession> {
    return this.channel(key, call).then(channel => channel.session);
  }

  /** Session-scoped request, with one new session if the upstream certainly did not process it. */
  async request(key: string, method: string, params: Record<string, unknown>, call: Call = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const channel = await this.channel(key, call);
      try { return await channel.request(method, params, call); }
      catch (error) {
        const retry = error instanceof UpstreamError && (error.message === SESSION_EXPIRED || error.message === RENEGOTIATE);
        if (retry && attempt === 0) {
          if (error.message === RENEGOTIATE) this.era = null;
          const current = this.sessions.get(key);
          if (current) this.drop(key, current);
          continue;
        }
        if (retry) fail("unavailable");
        throw error;
      } finally {
        const current = this.sessions.get(key);
        if (current) this.arm(key, current);
      }
    }
  }

  async listTools(key: string, call: Call = {}): Promise<UpstreamTool[]> {
    const tools: UpstreamTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.request(key, "tools/list", cursor ? { cursor } : {}, call);
      if (!object(result) || !Array.isArray(result.tools)) fail("protocol");
      const value = result as { tools: unknown[]; nextCursor?: unknown };
      for (const tool of value.tools) {
        if (!object(tool) || typeof tool.name !== "string" || !/^[A-Za-z0-9_./-]{1,128}$/.test(tool.name) || !object(tool.inputSchema)) continue;
        tools.push({
          name: tool.name,
          ...(typeof tool.title === "string" ? { title: tool.title.slice(0, 200) } : {}),
          ...(typeof tool.description === "string" ? { description: tool.description.slice(0, 4000) } : {}),
          inputSchema: tool.inputSchema,
          ...(object(tool.annotations) ? { hints: hints(tool.annotations) } : {}),
        });
      }
      if (typeof value.nextCursor !== "string" || !value.nextCursor) return unique(tools);
      cursor = value.nextCursor;
    }
    return unique(tools);
  }

  async callTool(key: string, name: string, args: Record<string, unknown>, call: Call = {}): Promise<Record<string, unknown>> {
    const result = await this.request(key, "tools/call", { name, arguments: args }, call);
    if (!object(result) || !Array.isArray(result.content)) fail("protocol");
    const value = result as Record<string, unknown>;
    return {
      content: value.content,
      ...(object(value.structuredContent) ? { structuredContent: value.structuredContent } : {}),
      ...(value.isError === true ? { isError: true } : {}),
    };
  }
}

/** How an era reads to the operator, e.g. "Streamable HTTP (2026-07-28)". */
export function transportLabel(transport: UpstreamTransport, version: string): string {
  if (transport === "sse") return `HTTP+SSE (${version}, deprecated)`;
  if (transport === "stdio") return `stdio (${version})`;
  return `Streamable HTTP (${version})`;
}

const RPC_MESSAGES: Record<number, string> = {
  [-32602]: "The connected service rejected the arguments.",
  [-32601]: "The connected service does not offer that method.",
  [-32600]: "The connected service rejected the request.",
};
/** A JSON-RPC error the upstream returned. Carries a local message chosen by code, never upstream text. */
export class UpstreamRpcError extends Error {
  constructor(public readonly code: number) { super(RPC_MESSAGES[code] ?? "The connected service returned an error."); this.name = "UpstreamRpcError"; }
}
