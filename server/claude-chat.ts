import { childEnvironment } from "./child-env";
/**
 * claude.ai chat management via the server's authorized browser profile
 * (~/.config/claude-browser). Two jobs:
 *  - a background queue that deletes chats (Claude Code sessions) by id,
 *    batched into one browser run, retried up to 3 times;
 *  - the login flow for the PWA's "claude.ai browser" re-auth sheet.
 */
import { db } from "./db";
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BROWSER_DIR = join(homedir(), ".config", "claude-browser");
const STATUS_FILE = join(BROWSER_DIR, "auth-status.json");
const CODE_FILE = join(BROWSER_DIR, "code.txt");
const LOGIN_PID_FILE = join(BROWSER_DIR, "login.pid");
const PROFILE_EMAIL_FILE = join(BROWSER_DIR, "profile-email");
const ROOT = new URL("..", import.meta.url).pathname;
const NODE_MODULES = join(ROOT, "node_modules");

const SID_RE = /session_[A-Za-z0-9]+/;

/* ---------- browser process groups ----------
 * Each browser run starts under setsid, so its process group holds xvfb-run, Xvfb, node and
 * Chromium. Killing only xvfb-run (Bun's child) leaves Chromium holding the profile. */

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

async function killGroup(pgid: number): Promise<void> {
  try { process.kill(-pgid, "SIGTERM"); } catch { return; }
  for (let i = 0; i < 20 && groupAlive(pgid); i++) await Bun.sleep(250);
  try { process.kill(-pgid, "SIGKILL"); } catch {}
}

/** The login group recorded on disk, so one that outlived a server restart is still found. */
function recordedLogin(): number | null {
  try {
    const pgid = Number(readFileSync(LOGIN_PID_FILE, "utf8"));
    if (!Number.isInteger(pgid) || pgid <= 1 || !groupAlive(pgid)) return null;
    if (existsSync("/proc") && !readFileSync(`/proc/${pgid}/cmdline`, "utf8").includes("browser-login.cjs")) return null;
    return pgid;
  } catch { return null; }
}

/** True while a sign-in owns the browser profile; the deletion queue waits for it. */
export function loginRunning(): boolean {
  return recordedLogin() !== null;
}

async function run(cmd: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["setsid", ...cmd], { stdout: "pipe", stderr: "pipe", env: childEnvironment({ NODE_PATH: NODE_MODULES }) });
  const timer = setTimeout(() => { killGroup(p.pid).catch(() => {}); }, timeoutMs);
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out };
}

/* ---------- deletion queue ---------- */

export function queueChatDeletion(claudeUrl: string | null): boolean {
  const sid = claudeUrl?.match(SID_RE)?.[0];
  if (!sid) return false;
  db.query(
    "INSERT INTO chat_deletions (sid, created_at) VALUES (?, ?) " +
    "ON CONFLICT(sid) DO UPDATE SET status = 'pending' WHERE chat_deletions.status = 'failed'",
  ).run(sid, Date.now());
  setTimeout(() => { processQueue(); }, 500); // fire soon, off the request path
  return true;
}

let processing = false;

export async function processQueue(): Promise<void> {
  // Two Chromiums on one profile corrupt it; the 5-minute sweep picks the queue up after sign-in.
  if (processing || loginRunning()) return;
  const rows = db.query(
    "SELECT sid FROM chat_deletions WHERE status = 'pending' AND attempts < 3 LIMIT 20",
  ).all() as { sid: string }[];
  if (!rows.length) return;
  processing = true;
  try {
    const ids = rows.map((r) => r.sid);
    db.query(`UPDATE chat_deletions SET attempts = attempts + 1 WHERE sid IN (${ids.map(() => "?").join(",")})`).run(...ids);
    rmSync(join(BROWSER_DIR, "profile", "SingletonLock"), { force: true });
    const { out } = await run(["xvfb-run", "-a", "node", join(ROOT, "scripts", "delete-chats.cjs"), ids.join(",")], 180_000);
    for (const line of out.split("\n")) {
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.auth === "expired") {
        db.query("UPDATE chat_deletions SET status = 'failed', last_error = 'browser login expired' WHERE status = 'pending'").run();
        return;
      }
      if (r.id) {
        db.query("UPDATE chat_deletions SET status = ?, last_error = ?, done_at = ? WHERE sid = ?")
          .run(r.ok ? "done" : "failed", r.ok ? null : String(r.note ?? "").slice(0, 200), r.ok ? Date.now() : null, r.id);
      }
    }
    // anything the script never reported stays pending for the next pass
  } finally {
    processing = false;
  }
}

// retry sweep for transient failures
setInterval(() => { processQueue().catch(() => {}); }, 5 * 60_000);

export interface ChatQueueState {
  authed: boolean;          // browser profile has ever completed a login
  authExpired: boolean;     // last run bounced to the login page
  pending: number;
  failed: number;
}

export function queueState(): ChatQueueState {
  const pending = (db.query("SELECT COUNT(*) n FROM chat_deletions WHERE status = 'pending'").get() as { n: number }).n;
  const failed = (db.query("SELECT COUNT(*) n FROM chat_deletions WHERE status = 'failed'").get() as { n: number }).n;
  const expired = !!db.query("SELECT 1 FROM chat_deletions WHERE last_error = 'browser login expired' AND status = 'failed' LIMIT 1").get();
  return { authed: existsSync(join(BROWSER_DIR, "profile", "Default")) || existsSync(join(BROWSER_DIR, "profile", "Cookies")), authExpired: expired, pending, failed };
}

export function retryFailed(): number {
  return db.query("UPDATE chat_deletions SET status = 'pending', attempts = 0 WHERE status = 'failed'").run().changes;
}

/* ---------- browser login flow (PWA sheet) ---------- */

let loginProc: ReturnType<typeof Bun.spawn> | null = null;

/** End the whole login group, including one started before the server last restarted. */
async function stopLogin(): Promise<void> {
  const groups = new Set<number>();
  if (loginProc && loginProc.exitCode === null) groups.add(loginProc.pid);
  const recorded = recordedLogin();
  if (recorded) groups.add(recorded);
  await Promise.all([...groups].map(killGroup));
  loginProc = null;
  try { unlinkSync(LOGIN_PID_FILE); } catch {}
}

/** Starting again (or "Send a new code") replaces any login still waiting, so the new email's code is the one used. */
export async function startBrowserAuth(): Promise<{ ok: boolean; error?: string }> {
  const email = process.env.CAI_EMAIL?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Configure CAI_EMAIL before starting browser login." };
  await stopLogin();
  // Wait out a deletion run: it has the profile open.
  for (let i = 0; i < 240 && processing; i++) await Bun.sleep(500);
  if (processing) return { ok: false, error: "Chat deletion is using the browser — try again in a minute." };
  try { unlinkSync(STATUS_FILE); } catch {}
  try { unlinkSync(CODE_FILE); } catch {}
  // A profile signed in to another account would delete (or report "already gone") the wrong chats.
  let profileEmail = "";
  try { profileEmail = readFileSync(PROFILE_EMAIL_FILE, "utf8").trim(); } catch {}
  if (profileEmail !== email) {
    rmSync(join(BROWSER_DIR, "profile"), { recursive: true, force: true });
    writeFileSync(PROFILE_EMAIL_FILE, email, { mode: 0o600 });
  }
  rmSync(join(BROWSER_DIR, "profile", "SingletonLock"), { force: true });
  // setsid gives the login its own process group, so stopLogin can end all of it.
  loginProc = Bun.spawn(["setsid", "xvfb-run", "-a", "node", join(ROOT, "scripts", "browser-login.cjs")], {
    stdout: "ignore", stderr: "ignore", env: childEnvironment({ NODE_PATH: NODE_MODULES, CAI_EMAIL: email }),
  });
  writeFileSync(LOGIN_PID_FILE, String(loginProc.pid), { mode: 0o600 });
  return { ok: true };
}

export function browserAuthStatus(): { running: boolean; state: string; message: string; email: string } {
  let state = "idle", message = "";
  try {
    const s = JSON.parse(readFileSync(STATUS_FILE, "utf8"));
    state = s.state; message = s.message ?? "";
  } catch {}
  return { running: loginRunning(), state, message, email: process.env.CAI_EMAIL?.trim() ?? "" };
}

export function submitBrowserCode(code: string): { ok: boolean; error?: string } {
  if (!/^[\w-]{4,60}$/.test(code)) return { ok: false, error: "That doesn't look like a code." };
  writeFileSync(CODE_FILE, code, { mode: 0o600 });
  return { ok: true };
}

export async function cancelBrowserAuth(): Promise<{ ok: boolean }> {
  await stopLogin();
  return { ok: true };
}
