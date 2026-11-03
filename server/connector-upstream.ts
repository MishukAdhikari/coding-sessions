/**
 * A deliberately small Streamable HTTP MCP client for the connector gateway.
 * It speaks only what a tools gateway needs (initialize, tools/list, tools/call,
 * cancellation) and treats every upstream byte as untrusted: bounded size and time,
 * no redirects, and errors classified without echoing upstream bodies.
 */
export const UPSTREAM_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_BYTES = 4 * 1024 * 1024;

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
const fail = (kind: UpstreamFailure): never => { throw new UpstreamError(kind, MESSAGES[kind]); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export interface UpstreamTool {
  name: string; title?: string; description?: string; inputSchema: Record<string, unknown>;
  /** The server's own annotations, kept only to show the operator. */
  hints?: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean; openWorld?: boolean };
}
export interface UpstreamSession { protocolVersion: string; sessionId: string | null; instructions: string; serverInfo: { name: string; version: string | null } | null; expiresAt: number }
export interface UpstreamOptions {
  url: URL;
  /**
   * The credential for one request, resolved just before it is sent (it may refresh first).
   * null sends no Authorization header (a server that needs none).
   */
  credential: (signal: AbortSignal) => string | null | Promise<string | null>;
  /** Other secrets to scrub from responses besides the one actually sent (recent tokens). */
  secrets?: () => string[];
  /** The resource rejected exactly this credential (HTTP 401). */
  onAuthRejected?: (credential: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  onToolsChanged?: () => void;
}
interface Call { signal?: AbortSignal; timeoutMs?: number }
interface Posted { response: Response; signal: AbortSignal; release: () => void; credential: string | null }

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
const SESSION_EXPIRED = "session-expired";
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

/** A name listed more than once (e.g. across pages) is ambiguous: drop every copy. */
function unique(tools: UpstreamTool[]): UpstreamTool[] {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return tools.filter(tool => counts.get(tool.name) === 1);
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

/** Consume an SSE stream until the response for `id` arrives; notifications along the way are inspected, never forwarded. */
async function sseResponse(response: Response, id: number, signal: AbortSignal, onMessage: (value: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) fail("protocol");
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) { await reader!.cancel().catch(() => {}); fail("too_large"); }
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line === "") {
          if (data.length) {
            let value: unknown;
            try { value = JSON.parse(data.join("\n")); } catch { fail("protocol"); }
            data = [];
            if (!object(value)) fail("protocol");
            const message = value as Record<string, unknown>;
            if (message.id === id && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
              await reader!.cancel().catch(() => {});
              return message;
            }
            onMessage(message);
          }
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        // event:, id:, retry: and comments carry nothing this gateway needs.
      }
      if (signal.aborted) break;
    }
  } finally { try { reader!.releaseLock(); } catch {} }
  return signal.aborted ? fail("cancelled") : fail("protocol");
}

export class UpstreamClient {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly sessions = new Map<string, Promise<UpstreamSession>>();
  private sequence = 0;
  constructor(private readonly options: UpstreamOptions) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private readonly lifetime = new AbortController();
  /** Forget a cached session (e.g. before a fresh settings check). */
  reset(key?: string): void { if (key === undefined) this.sessions.clear(); else this.sessions.delete(key); }
  /** Permanently stop: in-flight requests (including a shared initialize) abort and new ones fail before sending. */
  close(): void { this.sessions.clear(); this.lifetime.abort(new UpstreamError("cancelled", MESSAGES.cancelled)); }

  private async post(body: Record<string, unknown>, session: UpstreamSession | null, call: Call): Promise<Posted> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new UpstreamError("timeout", MESSAGES.timeout)), call.timeoutMs ?? this.options.timeoutMs ?? 120_000);
    const onAbort = () => abort.abort(new UpstreamError("cancelled", MESSAGES.cancelled));
    call.signal?.addEventListener("abort", onAbort, { once: true });
    this.lifetime.signal.addEventListener("abort", onAbort, { once: true });
    if (call.signal?.aborted || this.lifetime.signal.aborted) onAbort();
    const release = () => { clearTimeout(timeout); call.signal?.removeEventListener("abort", onAbort); this.lifetime.signal.removeEventListener("abort", onAbort); };
    try {
      if (abort.signal.aborted) throw abort.signal.reason;
      const credential = await this.options.credential(abort.signal);
      // Cancelled or closed while the credential was being prepared: send nothing.
      if (abort.signal.aborted) throw abort.signal.reason;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      };
      if (session) headers["mcp-protocol-version"] = session.protocolVersion;
      if (session?.sessionId) headers["mcp-session-id"] = session.sessionId;
      const response = await this.fetch(this.options.url, { method: "POST", redirect: "error", headers, body: JSON.stringify(body), signal: abort.signal });
      return { response, signal: abort.signal, release, credential };
    } catch (error) {
      release();
      // A local failure (e.g. the credential cannot be opened) keeps its own class.
      if (!(error instanceof Error) || error.name === "ConnectorError" || error.name === "DestinationError" || error instanceof UpstreamError) throw error;
      return fail(reasonKind(abort.signal, "unavailable"));
    }
  }

  private async rpc(id: number, method: string, params: Record<string, unknown>, session: UpstreamSession | null, call: Call): Promise<{ result: unknown; sessionId: string | null }> {
    const { response, signal, release, credential } = await this.post({ jsonrpc: "2.0", id, method, params }, session, call);
    try {
      if (response.status === 401) { if (credential) this.options.onAuthRejected?.(credential); fail("auth"); }
      if (response.status === 403) fail("forbidden");
      if (response.status === 404 && session?.sessionId) throw new UpstreamError("unavailable", SESSION_EXPIRED);
      if (!response.ok) fail("unavailable");
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      let message: Record<string, unknown>;
      try {
        if (type === "text/event-stream") {
          message = await sseResponse(response, id, signal, value => this.notice(value));
        } else if (type === "application/json") {
          const parsed: unknown = JSON.parse(await boundedText(response, signal));
          if (!object(parsed)) fail("protocol");
          message = parsed as Record<string, unknown>;
        } else return fail("protocol");
      } catch (error) {
        if (error instanceof UpstreamError && !signal.aborted) throw error;
        return fail(reasonKind(signal, "protocol"));
      }
      if (signal.aborted) fail(reasonKind(signal, "cancelled"));
      // Scrub before anything is projected, cached or forwarded: initialize, tool lists and results alike.
      message = redact(message, [credential, ...(this.options.secrets?.() ?? [])]);
      if (message.jsonrpc !== "2.0" || message.id !== id) fail("protocol");
      if (object(message.error)) {
        // Upstream text can echo request data; only the numeric code crosses this boundary.
        throw new UpstreamRpcError(typeof message.error.code === "number" && Number.isSafeInteger(message.error.code) ? message.error.code : -32603);
      }
      if (!Object.hasOwn(message, "result")) fail("protocol");
      return { result: message.result, sessionId: response.headers.get("mcp-session-id") };
    } finally {
      release();
      response.body?.cancel().catch(() => {});
    }
  }

  private notice(message: Record<string, unknown>): void {
    if (message.method === "notifications/tools/list_changed") this.options.onToolsChanged?.();
  }

  private async notify(method: string, params: Record<string, unknown>, session: UpstreamSession): Promise<void> {
    try {
      const { response, release } = await this.post({ jsonrpc: "2.0", method, params }, session, { timeoutMs: 5000 });
      release();
      await response.body?.cancel().catch(() => {});
    } catch { /* Best effort: a notification has no reply to wait for. */ }
  }

  /** One upstream session per key (a launch, or settings checks), so transport state never crosses launches. */
  session(key: string, call: Call = {}): Promise<UpstreamSession> {
    const cached = this.sessions.get(key);
    if (cached) return waitFor(cached, call.signal).then(value => value.expiresAt > this.now() ? value : (this.sessions.delete(key), this.session(key, call)));
    // Shared by every waiter for this key, so it runs on its own timeout; each waiter cancels only its own wait.
    const created = (async () => {
      const { result, sessionId } = await this.rpc(++this.sequence, "initialize", {
        protocolVersion: UPSTREAM_VERSIONS[0], capabilities: {},
        clientInfo: { name: "coding-sessions-connector-gateway", version: "1.0.0" },
      }, null, { timeoutMs: Math.min(call.timeoutMs ?? 20_000, 20_000) });
      if (!object(result) || typeof result.protocolVersion !== "string" || !UPSTREAM_VERSIONS.includes(result.protocolVersion)) fail("protocol");
      const value = result as Record<string, unknown>;
      if (!object(value.capabilities) || !object(value.capabilities.tools)) fail("protocol");
      const session: UpstreamSession = {
        protocolVersion: value.protocolVersion as string,
        sessionId: sessionId && /^[\x21-\x7e]{1,256}$/.test(sessionId) ? sessionId : null,
        instructions: typeof value.instructions === "string" ? value.instructions.slice(0, 16384) : "",
        serverInfo: serverInfo(value.serverInfo),
        expiresAt: this.now() + 30 * 60_000,
      };
      await this.notify("notifications/initialized", {}, session);
      return session;
    })();
    this.sessions.set(key, created);
    created.catch(() => { if (this.sessions.get(key) === created) this.sessions.delete(key); });
    return waitFor(created, call.signal);
  }

  /** Session-scoped request with one reinitialization if the upstream ended the session. */
  async request(key: string, method: string, params: Record<string, unknown>, call: Call = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const session = await this.session(key, call);
      try {
        const id = ++this.sequence;
        try { return (await this.rpc(id, method, params, session, call)).result; }
        catch (error) {
          if (error instanceof UpstreamError && error.kind === "cancelled") {
            void this.notify("notifications/cancelled", { requestId: id, reason: "Cancelled by the client." }, session);
          }
          throw error;
        }
      } catch (error) {
        // A 404 for a session means the request was not processed; retrying once is safe.
        if (error instanceof UpstreamError && error.message === SESSION_EXPIRED && attempt === 0) { this.sessions.delete(key); continue; }
        if (error instanceof UpstreamError && error.message === SESSION_EXPIRED) fail("unavailable");
        throw error;
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

const RPC_MESSAGES: Record<number, string> = {
  [-32602]: "The connected service rejected the arguments.",
  [-32601]: "The connected service does not offer that method.",
  [-32600]: "The connected service rejected the request.",
};
/** A JSON-RPC error the upstream returned. Carries a local message chosen by code, never upstream text. */
export class UpstreamRpcError extends Error {
  constructor(public readonly code: number) { super(RPC_MESSAGES[code] ?? "The connected service returned an error."); this.name = "UpstreamRpcError"; }
}
