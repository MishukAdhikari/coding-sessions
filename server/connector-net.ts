import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import ipaddr from "ipaddr.js";
import { readCsSetting } from "./environment";

type Environment = Record<string, string | undefined>;
export interface NetworkPolicy {
  /** Service-environment opt-in for local testing only (CS_CONNECTOR_ALLOW_LOOPBACK=1). Never set from the browser. */
  allowLoopback: boolean;
}
export const networkPolicy = (env: Environment = process.env): NetworkPolicy =>
  ({ allowLoopback: readCsSetting(env, "CS_CONNECTOR_ALLOW_LOOPBACK") === "1" });

/**
 * A transport failure proven to happen before any request byte was sent: the name did not resolve,
 * the connection was refused, or TLS verification failed during the handshake. Verified on Bun 1.3.14
 * (a TLS-failing server saw zero requests). Everything else, e.g. ECONNRESET or a timeout, may have
 * reached the server and is not one of these.
 */
export class PreSendError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "PreSendError"; }
}
// Only codes with evidence that no request byte was sent (connection refused, TLS verification).
// Unproven ones (e.g. EHOSTUNREACH, ENETUNREACH, EADDRNOTAVAIL) are deliberately absent: uncertain.
const PRE_SEND_CODES = new Set([
  "ECONNREFUSED",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_REVOKED", "CERT_UNTRUSTED", "CERT_REJECTED",
  "ERR_TLS_CERT_ALTNAME_INVALID", "HOSTNAME_MISMATCH",
]);
export const preSend = (error: unknown): PreSendError | null =>
  error instanceof PreSendError ? error
  : error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string" && PRE_SEND_CODES.has((error as NodeJS.ErrnoException).code!)
    ? new PreSendError("The server could not be reached; nothing was sent.", (error as NodeJS.ErrnoException).code!) : null;

export class DestinationError extends Error {
  /** True when the request had already been sent (the refusal concerns the response). */
  constructor(message: string, readonly afterSend = false) { super(message); this.name = "DestinationError"; }
}

/**
 * Only globally routable unicast addresses. ipaddr.js classifies private, loopback,
 * link-local (incl. cloud metadata 169.254.169.254), CGNAT, unique-local, multicast,
 * reserved, documentation, and v4-embedding v6 ranges (mapped, 6to4, Teredo, NAT64).
 * IPv4-mapped IPv6 is unwrapped first so it is judged as the IPv4 address it reaches.
 */
export function addressAllowed(address: string, policy: NetworkPolicy): boolean {
  if (!ipaddr.isValid(address)) return false;
  const range = ipaddr.process(address).range();
  return range === "unicast" || (policy.allowLoopback && range === "loopback");
}

/**
 * Syntax and literal-address checks. "server" is an operator-entered MCP server URL, which may
 * not carry a query (credentials go in the token field). "oauth" is an authorization-server
 * endpoint from validated metadata, which legitimately may.
 */
export type UrlRole = "server" | "oauth";
export function validateServerUrl(value: unknown, policy: NetworkPolicy, role: UrlRole = "server"): URL {
  if (typeof value !== "string" || value.length > 2048) throw new DestinationError("Enter the server's URL.");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new DestinationError("That is not a valid URL."); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopbackName = host === "localhost" || host.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && policy.allowLoopback && (loopbackName || (isIP(host) && addressAllowed(host, policy) && ipaddr.process(host).range() === "loopback")))) {
    throw new DestinationError("Use an https:// URL.");
  }
  if (url.username || url.password) throw new DestinationError("Remove the user name or password from the URL; add a token instead.");
  if (url.hash) throw new DestinationError("Remove the fragment from the URL.");
  if (url.search && role === "server") throw new DestinationError("Remove the query from the URL; put credentials in the token field.");
  if (isIP(host) && !addressAllowed(host, policy)) throw new DestinationError("That address is private, local or reserved, so it cannot be used.");
  if (loopbackName && !policy.allowLoopback) throw new DestinationError("Local addresses cannot be used.");
  return url;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;
export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const systemResolver: Resolver = hostname => new Promise((resolve, reject) =>
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));

/**
 * Resolve once, require every answer to be allowed, and hand only vetted addresses to the
 * socket. The URL keeps its hostname, so Host, SNI and native certificate verification
 * all use the name the operator entered: a rebinding answer cannot reach a blocked address,
 * and a vetted address serving another name fails TLS before any request bytes are sent.
 */
function vettedLookup(policy: NetworkPolicy, resolver: Resolver) {
  return (hostname: string, options: { all?: boolean } | number, callback: LookupCallback) => {
    resolver(hostname).then(addresses => {
      if (!addresses.length || addresses.some(entry => !addressAllowed(entry.address, policy))) {
        const error = new DestinationError("The server's address is private, local or reserved, so it cannot be used.") as unknown as NodeJS.ErrnoException;
        error.code = "EDESTINATION";
        callback(error, "", 0);
        return;
      }
      if (typeof options === "object" && options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    }, error => {
      // Name resolution happens before any connection: whatever failed, nothing was sent.
      const code = typeof (error as NodeJS.ErrnoException)?.code === "string" ? (error as NodeJS.ErrnoException).code! : "ENOTFOUND";
      callback(new PreSendError("The server's name could not be resolved; nothing was sent.", code) as unknown as NodeJS.ErrnoException, "", 0);
    });
  };
}

export interface SafeFetchOptions { policy: NetworkPolicy; resolver?: Resolver; ca?: string | Buffer; env?: Environment; role?: UrlRole }
/** Some edge protections challenge generic clients; identify ourselves plainly. */
export const USER_AGENT = "Coding-Sessions/1.0 (+MCP connector)";

/** Reads a response body as text with a hard byte cap, cancelling the stream past it. */
export async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new DestinationError("The server's response was too large."); }
      chunks.push(chunk.value);
    }
  } finally { try { reader.releaseLock(); } catch {} }
  return Buffer.concat(chunks).toString("utf8");
}

const PROXY_VARIABLES = ["http_proxy", "https_proxy", "all_proxy"];
/**
 * Bun applies proxy variables to fetch and to node:http(s) (built on fetch) at request time,
 * and a proxy resolves and connects on its own, bypassing the vetted lookup. Verified on
 * Bun 1.3.14: requests reached a proxy set this way, and proxy: "" did not disable it.
 * Proxied egress is therefore refused rather than trusted.
 */
export function proxyConfigured(env: Environment = process.env): string | null {
  for (const [name, value] of Object.entries(env)) {
    if (value && PROXY_VARIABLES.includes(name.toLowerCase())) return name;
  }
  return null;
}

/**
 * A fetch-shaped request for the upstream client: vetted destination, redirects refused,
 * proxied egress refused (see proxyConfigured), abortable through the whole response.
 * Bun's node:https runs on its fetch internally; the vetted lookup is still invoked (verified).
 */
export function safeFetch(options: SafeFetchOptions): typeof fetch {
  const lookup = vettedLookup(options.policy, options.resolver ?? systemResolver);
  return (async (input: URL | string, init: RequestInit = {}) => {
    const url = validateServerUrl(String(input), options.policy, options.role ?? "server");
    const proxy = proxyConfigured(options.env ?? process.env);
    if (proxy) throw new DestinationError(`Connector requests are refused while ${proxy} is set for this service: a proxy would choose the destination itself.`);
    const signal = init.signal ?? undefined;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    headers["user-agent"] ??= USER_AGENT;
    const method = (init.method ?? "GET").toUpperCase();
    // Only string bodies are sent (JSON-RPC, form-encoded); GET and HEAD carry none.
    const body = method === "GET" || method === "HEAD" ? null : typeof init.body === "string" ? init.body : "";
    if (body !== null) headers["content-length"] = String(Buffer.byteLength(body));
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } req.destroy(); };
      const req = send(url, {
        method, headers, lookup: lookup as never, agent: false,
        // Explicit: an ambient NODE_TLS_REJECT_UNAUTHORIZED=0 must not disable verification here (verified on Linux).
        ...(url.protocol === "https:" ? { rejectUnauthorized: true, servername: url.hostname.replace(/^\[|\]$/g, ""), ...(options.ca ? { ca: options.ca } : {}) } : {}),
      }, (res: IncomingMessage) => {
        const status = res.statusCode;
        // Anything outside 200–599 cannot become a Response (a 600 would throw); redirects are never followed.
        // Both end the connection rather than draining a body the server controls.
        if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) { res.destroy(); fail(new DestinationError("The server sent an invalid response.", true)); return; }
        if (status >= 300 && status < 400) { res.destroy(); fail(new DestinationError("The server tried to redirect; redirects are not followed.", true)); return; }
        try {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach(entry => responseHeaders.append(name, entry));
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          const nullBody = status === 204 || (status === 202 && res.headers["content-length"] === "0");
          const response = new Response(nullBody ? null : Readable.toWeb(res) as ReadableStream, { status, headers: responseHeaders });
          if (nullBody) res.destroy();
          settled = true;
          resolve(response);
        } catch (error) { res.destroy(); fail(error); }
      });
      // Bun's node:http does not reliably reject on an aborted signal; destroy the request ourselves,
      // and keep listening until the body closes so cancelling mid-stream ends the connection.
      const onAbort = () => fail(signal?.reason ?? new Error("aborted"));
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", error => { cleanup(); fail(preSend(error) ?? error); });
      req.on("close", () => { if (settled) return; cleanup(); fail(new DestinationError("The connection closed before a response.", true)); });
      req.on("response", res => res.on("close", cleanup));
      req.end(body ?? undefined);
    });
  }) as typeof fetch;
}
