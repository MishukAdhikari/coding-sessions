import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export function resolvePublicFile(publicDir: string, pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname);
    if (!decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0")) return null;
    const parts = decoded.split("/");
    if (parts.some(part => part.startsWith("."))) return null;
    const root = realpathSync(publicDir);
    const file = realpathSync(resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`));
    if (!file.startsWith(root + sep) || !statSync(file).isFile()) return null;
    if (file.slice(root.length + 1).split(sep).some(part => part.startsWith("."))) return null;
    return file;
  } catch { return null; }
}

/** Parse CS_TRUSTED_PROXIES: comma-separated IP ranges (CIDR) a reverse proxy may connect from. */
export function parseTrustedProxies(value: string | undefined): Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> {
  return (value ?? "").split(",").map((part) => part.trim()).filter(Boolean).map((cidr) => {
    try { return ipaddr.parseCIDR(cidr); } catch { throw new Error(`CS_TRUSTED_PROXIES has an invalid range: ${cidr}`); }
  });
}

function fromTrustedProxy(socket: string, ranges: ReadonlyArray<[ipaddr.IPv4 | ipaddr.IPv6, number]>): boolean {
  if (socket === "::1" || socket === "127.0.0.1" || socket === "::ffff:127.0.0.1") return true;
  if (!ranges.length || !ipaddr.isValid(socket)) return false;
  const address = ipaddr.process(socket);
  return ranges.some(([range, bits]) => address.kind() === range.kind() && address.match(range, bits));
}

/**
 * The visitor's address. Forwarded headers count only when the connection itself
 * comes from loopback or a configured proxy range (a container network, say).
 */
export function requestClientIp(req: Request, socketAddress: string | null | undefined, trustProxy: boolean,
  trustedProxies: ReadonlyArray<[ipaddr.IPv4 | ipaddr.IPv6, number]> = []): string {
  const socket = socketAddress ?? "unknown";
  if (!trustProxy || !fromTrustedProxy(socket, trustedProxies)) return socket;
  const forwarded = req.headers.get("x-real-ip")?.trim()
    ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded && isIP(forwarded) ? forwarded : socket;
}

/** Browser mutations must come from the configured origin; bearer clients may omit Origin. */
export function allowsApiMutation(req: Request, origin: string, cookieName: string): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const suppliedOrigin = req.headers.get("origin");
  if (suppliedOrigin !== null) return suppliedOrigin === origin;
  const cookie = req.headers.get("cookie") ?? "";
  return !cookie.split(";").some(part => part.trim().split("=", 1)[0] === cookieName);
}
