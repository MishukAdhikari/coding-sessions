/**
 * MCP 2026-07-28 (stateless) on top of the initialize-era handling each endpoint keeps.
 *
 * A request is modern when its params._meta names io.modelcontextprotocol/protocolVersion;
 * `initialize` and every request without that key are legacy and are answered exactly as
 * before. Modern requests carry the version and client capabilities in _meta on every call,
 * repeat the method (and tool name or resource URI) in headers, have no session, and get
 * `resultType: "complete"` on every result.
 *
 * No imports: the stdio bridges load this file from an installed, possibly read-only tree.
 */

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
/** The stateless versions we answer; initialize never offers these. */
export const MODERN_PROTOCOL_VERSIONS = [MODERN_PROTOCOL_VERSION];
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
/** How long a client may reuse a discover result; private because it depends on the caller's token. */
export const DISCOVER_TTL_MS = 300_000;

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const rpcError = (id: unknown, code: number, message: string, data?: unknown) =>
  ({ jsonrpc: "2.0", id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } });

/** Whether a JSON-RPC message is a 2026-style request or notification (initialize never is). */
export function isModernMessage(msg: unknown): boolean {
  return object(msg) && msg.method !== "initialize" && object(msg.params) && object(msg.params._meta)
    && Object.hasOwn(msg.params._meta, META_PROTOCOL_VERSION);
}

/** The params field a method's Mcp-Name header repeats, if it has one. */
function nameField(method: unknown): "name" | "uri" | null {
  if (method === "tools/call" || method === "prompts/get") return "name";
  if (method === "resources/read") return "uri";
  return null;
}

/** A header value as sent: plain when it is safe printable ASCII, else =?base64?…?=. */
export function encodeHeaderValue(value: string): string {
  return /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value) ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function decodeHeaderValue(value: string): string {
  const m = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/i.exec(value.trim());
  return m ? Buffer.from(m[1]!, "base64").toString("utf8") : value.trim();
}

/** The headers a modern request must carry, derived from the message itself (for the stdio bridges). */
export function modernHeaders(msg: Record<string, any>): Record<string, string> {
  const headers: Record<string, string> = {};
  const version = msg.params?._meta?.[META_PROTOCOL_VERSION];
  if (typeof version === "string") headers["mcp-protocol-version"] = encodeHeaderValue(version);
  if (typeof msg.method === "string") headers["mcp-method"] = encodeHeaderValue(msg.method);
  const field = nameField(msg.method);
  const name = field ? msg.params?.[field] : undefined;
  if (typeof name === "string") headers["mcp-name"] = encodeHeaderValue(name);
  return headers;
}

export interface Rejection { status: number; body: object }

/**
 * Validate a modern request: required _meta, a version we speak, and headers that match the
 * body. `legacyVersions` are the initialize-era versions, listed after the modern ones in an
 * unsupported-version error. Returns null when the request may be served.
 */
export function checkModernRequest(msg: Record<string, any>, headers: Headers, legacyVersions: readonly string[]): Rejection | null {
  const id = msg.id ?? null;
  const meta = msg.params._meta as Record<string, unknown>;
  const version = meta[META_PROTOCOL_VERSION];
  if (typeof version !== "string" || !version) {
    return { status: 400, body: rpcError(id, -32602, `Invalid params: _meta["${META_PROTOCOL_VERSION}"] must be a string.`) };
  }
  if (!object(meta[META_CLIENT_CAPABILITIES])) {
    return { status: 400, body: rpcError(id, -32602, `Invalid params: _meta["${META_CLIENT_CAPABILITIES}"] is required.`) };
  }
  if (!MODERN_PROTOCOL_VERSIONS.includes(version)) {
    return { status: 400, body: rpcError(id, -32022, "Unsupported protocol version",
      { supported: [...MODERN_PROTOCOL_VERSIONS, ...legacyVersions], requested: version }) };
  }
  const mismatch = (header: string, expected: string): Rejection | null => {
    const sent = headers.get(header);
    if (sent === null) return { status: 400, body: rpcError(id, -32020, `Header mismatch: ${header} is required.`) };
    if (decodeHeaderValue(sent) !== expected) return { status: 400, body: rpcError(id, -32020, `Header mismatch: ${header} does not match the request body.`) };
    return null;
  };
  const field = nameField(msg.method);
  const name = field ? msg.params[field] : undefined;
  return mismatch("MCP-Protocol-Version", version)
    ?? mismatch("Mcp-Method", msg.method)
    ?? (typeof name === "string" ? mismatch("Mcp-Name", name) : null);
}

/** A batch may hold legacy messages only: 2026 has no JSON-RPC batch. */
export function modernBatchRejection(batch: unknown[]): Rejection | null {
  return batch.some(isModernMessage)
    ? { status: 400, body: rpcError(null, -32600, "Invalid request: batches are not supported for protocol version 2026-07-28.") }
    : null;
}

/** The server/discover result, from what initialize advertises. */
export function discoverResult(server: { capabilities: object; serverInfo: object; instructions?: string }): object {
  return {
    resultType: "complete",
    supportedVersions: MODERN_PROTOCOL_VERSIONS,
    capabilities: server.capabilities,
    _meta: { [META_SERVER_INFO]: server.serverInfo },
    ...(server.instructions ? { instructions: server.instructions } : {}),
    ttlMs: DISCOVER_TTL_MS,
    cacheScope: "private",
  };
}

/** A reply to a modern request: results marked complete, an unknown method answered 404. */
export function modernReply(reply: Record<string, any>): { status: number; body: object } {
  if (object(reply.result)) return { status: 200, body: { ...reply, result: { resultType: "complete", ...reply.result } } };
  if (object(reply.error) && reply.error.code === -32601) return { status: 404, body: reply };
  return { status: 200, body: reply };
}

export function modernResponse(reply: Record<string, any>): Response {
  const { status, body } = modernReply(reply);
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function rejectionResponse(rejection: Rejection): Response {
  return Response.json(rejection.body, { status: rejection.status, headers: { "cache-control": "no-store" } });
}
