import { createHash, randomBytes, randomInt } from "node:crypto";
import { hasBrowserSession, PRIVATE_NO_STORE_HEADERS } from "./browser-session";

/*
 * Browser sign-in for the `cs` CLI, device-code style so it also works over SSH.
 *
 *   cs     POST /api/cli-login/start {label}   → code (secret, for polling) + user_code (short, shown)
 *   app    #cli-login=USERCODE opens a sheet; Allow posts /api/cli-login/approve {user_code}
 *   cs     POST /api/cli-login/poll {code}     → {token} once, after approval
 *
 * Codes live in memory as hashes only, last 10 minutes and are spent by the first
 * answer. The user code is not a credential: approving takes a signed-in browser on
 * the app's own origin. The token is minted only when cs collects it, so it is never
 * stored here and never put in a URL.
 */

const TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_S = 2;
const MAX_PENDING = 50;
// No vowels or look-alikes: codes never spell words and survive being read aloud.
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

type State = "pending" | "approved" | "denied";
interface Request { codeHash: string; userHash: string; label: string; state: State; expiresAt: number }

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Upper-case, keep letters and digits: "bcdf-ghjk" and "BCDFGHJK" are the same code. */
export function normalizeUserCode(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

/** A short, printable device name: control characters and markup-ish bits go. */
export function cleanLabel(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/[^\p{L}\p{N} ._@()'-]/gu, "").replace(/\s+/g, " ").trim() : "";
  return text.slice(0, 40) || "a computer";
}

export function createCliLogins(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const requests = new Map<string, Request>(); // by hash of the polling code

  const sweep = () => { for (const [key, r] of requests) if (r.expiresAt <= now()) requests.delete(key); };
  const byUserCode = (userCode: unknown) => {
    sweep();
    const hash = sha256(normalizeUserCode(userCode));
    for (const r of requests.values()) if (r.userHash === hash) return r;
    return null;
  };

  return {
    start(label: unknown): { code: string; userCode: string; expiresIn: number } | null {
      sweep();
      if (requests.size >= MAX_PENDING) return null;
      const code = randomBytes(32).toString("base64url");
      const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
      const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      requests.set(sha256(code), { codeHash: sha256(code), userHash: sha256(raw), label: cleanLabel(label), state: "pending", expiresAt: now() + TTL_MS });
      return { code, userCode, expiresIn: TTL_MS / 1000 };
    },
    /** What the approval sheet shows. */
    describe(userCode: unknown): { label: string; expiresIn: number } | null {
      const r = byUserCode(userCode);
      return r && r.state === "pending" ? { label: r.label, expiresIn: Math.ceil((r.expiresAt - now()) / 1000) } : null;
    },
    answer(userCode: unknown, allow: boolean): boolean {
      const r = byUserCode(userCode);
      if (!r || r.state !== "pending") return false;
      r.state = allow ? "approved" : "denied";
      return true;
    },
    /** pending → keep polling; approved/denied are returned once, then the code is gone. */
    poll(code: unknown): { state: State; label: string } | { state: "unknown" } {
      sweep();
      if (typeof code !== "string" || !code) return { state: "unknown" };
      const key = sha256(code);
      const r = requests.get(key);
      if (!r) return { state: "unknown" };
      if (r.state !== "pending") requests.delete(key);
      return { state: r.state, label: r.label };
    },
  };
}

export type CliLogins = ReturnType<typeof createCliLogins>;

export interface CliLoginRouteDependencies {
  origin: string;
  cookieName: string;
  checkBrowserSession: (token: string | null) => boolean;
  logins: CliLogins;
  mintToken: (label: string) => string;
  rateLimited: (key: string, max: number) => boolean;
  clientIp: (req: globalThis.Request) => string;
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: PRIVATE_NO_STORE_HEADERS });

export async function handleCliLoginRoute(req: globalThis.Request, deps: CliLoginRouteDependencies): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith("/api/cli-login/")) return null;
  const action = path.slice("/api/cli-login/".length);
  const ip = deps.clientIp(req);

  // The browser side: a signed-in session on the app's own origin, never a bearer token.
  if (action === "request" || action === "approve" || action === "deny") {
    if (!hasBrowserSession(req, deps.cookieName, deps.checkBrowserSession)) return json({ error: "Sign in to the app first." }, 401);
    if (deps.rateLimited(`cli-login-answer:${ip}`, 30)) return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
    if (action === "request" && req.method === "GET") {
      const found = deps.logins.describe(url.searchParams.get("user_code"));
      return found ? json({ label: found.label, expires_in: found.expiresIn }) : json({ error: "This sign-in request is unknown, used or expired. Run the command again." }, 404);
    }
    if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
    if (req.headers.get("origin") !== deps.origin) return json({ error: "Same-origin request required." }, 403);
    const body = await req.json().catch(() => ({})) as { user_code?: unknown };
    if (!deps.logins.answer(body.user_code, action === "approve")) {
      return json({ error: "This sign-in request is unknown, used or expired. Run the command again." }, 404);
    }
    return json({ ok: true });
  }

  // The cs side: no credentials yet, so every call is rate-limited by address.
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const body = await req.json().catch(() => ({})) as { label?: unknown; code?: unknown };

  if (action === "start") {
    if (deps.rateLimited(`cli-login-start:${ip}`, 10)) return json({ error: "Too many sign-in attempts. Try again in 15 minutes." }, 429);
    const started = deps.logins.start(body.label);
    if (!started) return json({ error: "Too many sign-ins are waiting. Try again in a few minutes." }, 429);
    return json({
      code: started.code,
      user_code: started.userCode,
      verify_url: `${deps.origin}/#cli-login=${started.userCode}`,
      expires_in: started.expiresIn,
      interval: POLL_INTERVAL_S,
    });
  }

  if (action === "poll") {
    // About one poll every two seconds for ten minutes, with room for a few restarts.
    if (deps.rateLimited(`cli-login-poll:${ip}`, 1200)) return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
    const result = deps.logins.poll(body.code);
    if (result.state === "pending") return json({ status: "pending" });
    if (result.state === "denied") return json({ status: "denied", error: "Sign-in was denied in the app." }, 403);
    if (result.state === "approved") return json({ status: "approved", token: deps.mintToken(`cs on ${result.label}`) });
    return json({ status: "expired", error: "This sign-in expired or was already used. Run the command again." }, 410);
  }

  return json({ error: "Not found" }, 404);
}
