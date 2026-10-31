import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isIP } from "node:net";

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

export function requestClientIp(req: Request, socketAddress: string | null | undefined, trustProxy: boolean): string {
  const socket = socketAddress ?? "unknown";
  const loopback = socket === "::1" || socket === "127.0.0.1" || socket === "::ffff:127.0.0.1";
  if (!trustProxy || !loopback) return socket;
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
