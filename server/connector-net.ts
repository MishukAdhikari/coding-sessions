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

export class DestinationError extends Error {
  constructor(message: string) { super(message); this.name = "DestinationError"; }
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

/** Syntax and literal-address checks for an operator-entered MCP server URL. */
export function validateServerUrl(value: unknown, policy: NetworkPolicy): URL {
  if (typeof value !== "string" || value.length > 2048) throw new DestinationError("Enter the server's URL.");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new DestinationError("That is not a valid URL."); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopbackName = host === "localhost" || host.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && policy.allowLoopback && (loopbackName || (isIP(host) && addressAllowed(host, policy) && ipaddr.process(host).range() === "loopback")))) {
    throw new DestinationError("Use an https:// URL.");
  }
  if (url.username || url.password) throw new DestinationError("Remove the user name or password from the URL; add a token instead.");
  if (url.search || url.hash) throw new DestinationError("Remove the query or fragment from the URL; put credentials in the token field.");
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
    }, error => callback(error, "", 0));
  };
}

export interface SafeFetchOptions { policy: NetworkPolicy; resolver?: Resolver; ca?: string | Buffer; env?: Environment }

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
    const url = validateServerUrl(String(input), options.policy);
    const proxy = proxyConfigured(options.env ?? process.env);
    if (proxy) throw new DestinationError(`Connector requests are refused while ${proxy} is set for this service: a proxy would choose the destination itself.`);
    const signal = init.signal ?? undefined;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? init.body : "";
    headers["content-length"] = String(Buffer.byteLength(body));
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } req.destroy(); };
      const req = send(url, {
        method: init.method ?? "GET", headers, lookup: lookup as never, agent: false,
        // Explicit: an ambient NODE_TLS_REJECT_UNAUTHORIZED=0 must not disable verification here (verified on Linux).
        ...(url.protocol === "https:" ? { rejectUnauthorized: true, servername: url.hostname.replace(/^\[|\]$/g, ""), ...(options.ca ? { ca: options.ca } : {}) } : {}),
      }, (res: IncomingMessage) => {
        const status = res.statusCode;
        // Anything outside 200–599 cannot become a Response (a 600 would throw); redirects are never followed.
        // Both end the connection rather than draining a body the server controls.
        if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) { res.destroy(); fail(new DestinationError("The server sent an invalid response.")); return; }
        if (status >= 300 && status < 400) { res.destroy(); fail(new DestinationError("The server tried to redirect; redirects are not followed.")); return; }
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
      req.on("error", error => { cleanup(); fail(error); });
      req.on("close", () => { if (settled) return; cleanup(); fail(new DestinationError("The connection closed before a response.")); });
      req.on("response", res => res.on("close", cleanup));
      req.end(body);
    });
  }) as typeof fetch;
}
