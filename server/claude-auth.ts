import { readCsSetting } from "./environment";
import { childEnvironment } from "./child-env";
import { readClaudeIdentity } from "./account-identity";
import { existsSync, readFileSync, unlinkSync, mkdirSync, lstatSync, realpathSync, chmodSync, mkdtempSync, rmSync, openSync, closeSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { recordAccountLogin } from "./account-history";

/**
 * Re-authenticate the claude CLI from the app when its login is lost.
 * `claude auth login` needs a TTY, so it runs inside a dedicated GNU screen
 * (xs- prefix — invisible to session listing, which only scans cs-*).
 * The whole run is captured with `screen -L -Logfile`, so even if the process
 * dies instantly (missing binary, crash) the UI can show what went wrong.
 * Output is also snapshotted with `screen -X hardcopy`; the OAuth code is fed
 * back with `screen -X stuff`.
 */

const AUTH_SCREEN = "xs-claude-auth";
export function privateAuthFiles(base = readCsSetting(process.env, "CS_RUNTIME_DIR") ?? join(homedir(), ".local", "state", "xcloud-sessions")) {
  const directory = resolve(base, "auth");
  let ancestor = directory;
  while (ancestor !== resolve(ancestor, "..")) {
    try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error("Auth directory must not contain symlinks."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    ancestor = resolve(ancestor, "..");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory) throw new Error("Auth directory must not contain symlinks.");
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Auth directory must belong to the service account.");
  chmodSync(directory, 0o700);
  const attempt = mkdtempSync(join(directory, "claude-"));
  chmodSync(attempt, 0o700);
  const files = { hardcopy: join(attempt, "claude.txt"), log: join(attempt, "claude.log") };
  for (const file of Object.values(files)) {
    const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    closeSync(fd);
  }
  return files;
}
let authFiles: { hardcopy: string; log: string } | null = null;
function removeAuthFiles() {
  if (!authFiles) return;
  for (const file of Object.values(authFiles)) { try { unlinkSync(file); } catch {} }
  try { rmSync(resolve(authFiles.log, ".."), { recursive: true }); } catch {}
  authFiles = null;
}

/** Set once a code has been handed to the CLI, so status can say "checking" instead of "paste a code". */
let codeSubmitted = false;
export function createClaudeLoginTracker(record: () => void | Promise<void>) {
  let pending = false;
  return {
    begin() { pending = true; },
    cancel() { pending = false; },
    async observe(authorized: boolean | null, output: string) {
      const clean = cleanTerminalText(output);
      if (pending && authorized === true && !screenError(clean)
        && /^\s*(?:successfully logged in|login successful|authentication successful)\b/im.test(clean)) {
        pending = false;
        await record();
      }
    },
  };
}
const loginTracker = createClaudeLoginTracker(async () => recordAccountLogin("claude", await readClaudeIdentity()));

async function run(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { env: childEnvironment(), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

async function authScreenAlive(): Promise<boolean> {
  const { out } = await run(["screen", "-ls"]);
  return out.includes(`.${AUTH_SCREEN}\t`) || out.includes(`.${AUTH_SCREEN} `);
}

function claudeBinary(): string | null {
  const bin = Bun.which("claude") ?? join(homedir(), ".local", "bin", "claude");
  return existsSync(bin) ? bin : null;
}

/** Strip ANSI escapes and screen control noise so log tails are readable. */
function cleanTerminalText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[()][0-9A-B]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\r\x0e-\x1f]/g, "");
}

const readIfExists = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

async function hardcopy(): Promise<string> {
  const files = authFiles;
  if (!files) return "";
  await run(["screen", "-S", AUTH_SCREEN, "-X", "hardcopy", files.hardcopy]);
  return readIfExists(files.hardcopy);
}

export async function startAuth(): Promise<{ ok: boolean; error?: string }> {
  // A run that ended in "Press Enter to retry" keeps its screen alive forever with a
  // spent PKCE challenge — reusing it would hand out a login link that can never work.
  if (await authScreenAlive()) {
    if (!authFiles) await cancelAuth();
    else {
      if (!screenError(await hardcopy())) return { ok: true }; // genuinely still in progress
      await cancelAuth();
    }
  }
  codeSubmitted = false;
  loginTracker.cancel();
  removeAuthFiles();
  const claudeBin = claudeBinary();
  if (!claudeBin) {
    return {
      ok: false,
      error: `The claude CLI is not installed for the service user (looked on PATH and in ${join(homedir(), ".local", "bin")}). Install it as this user, then try again.`,
    };
  }
  authFiles = privateAuthFiles();
  const { code, err } = await run([
    "screen", "-dmS", AUTH_SCREEN, "-L", "-Logfile", authFiles.log, "bash", "-lc", `'${claudeBin}' auth login`,
  ]);
  if (code !== 0) { removeAuthFiles(); return { ok: false, error: err || "screen failed to start" }; }
  loginTracker.begin();
  await run(["screen", "-S", AUTH_SCREEN, "-X", "logfile", "flush", "0"]); // best-effort: log without the 10s buffer
  return { ok: true };
}

/** What the CLI is waiting on while the run is still alive. */
export type AuthStage = "starting" | "awaiting_code" | "checking" | "error";

export interface AuthStatus {
  running: boolean;
  url: string | null;
  tail: string;
  stage: AuthStage | null;
  /** Human-readable reason the run is stuck, when stage is "error". */
  error: string | null;
  /** Is the CLI actually logged in? null = couldn't determine. */
  authorized: boolean | null;
}

/** Ask the CLI itself whether it holds a login — the only trustworthy success signal. */
async function cliLoggedIn(): Promise<boolean | null> {
  const bin = claudeBinary();
  if (!bin) return null;
  const { out } = await run([bin, "auth", "status"]);
  try { return JSON.parse(out).loggedIn === true; } catch { return null; }
}

const URL_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/**
 * Pull the login URL out of terminal output. The CLI also emits it as an OSC 8
 * hyperlink target, which is the only copy that isn't hard-wrapped at the window
 * width — prefer it, and only fall back to stitching the visible wrapped lines.
 */
export function extractOauthUrl(text: string): string | null {
  const link = text.match(/\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b]*claude\.(?:ai|com)\/[^\x07\x1b]*)\x07/);
  if (link?.[1]) return link[1];

  const lines = cleanTerminalText(text).split("\n").map((l) => l.replace(/\s+$/, ""));
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]?.match(/https:\/\/\S*claude\.(?:ai|com)\/\S*$/);
    if (!head) continue;
    let url = head[0];
    // Only a full-width line was wrapped; a short one ended the URL.
    for (let j = i + 1; j < lines.length && (lines[j - 1]?.length ?? 0) >= 60; j++) {
      const next = lines[j]?.trim() ?? "";
      if (!next || /\s/.test(next) || !URL_CHARS.test(next)) break;
      url += next;
    }
    return url;
  }
  return null;
}

/** A rejected code leaves the CLI parked on a retry prompt rather than exiting. */
export function screenError(text: string): string | null {
  const clean = cleanTerminalText(text);
  const m = clean.match(/^\s*((?:OAuth error|Authentication failed|Login failed)[^\n]*)$/mi);
  if (m?.[1]) return m[1].trim();
  if (/Press Enter to retry/i.test(clean)) return "The code was rejected. Start over to get a fresh login link.";
  return null;
}

const lastLines = (text: string, n: number) => text.split("\n").filter((l) => l.trim()).slice(-n).join("\n");

export async function authStatus(): Promise<AuthStatus> {
  const running = await authScreenAlive();
  const log = authFiles ? readIfExists(authFiles.log) : "";
  let tail = "";
  let url: string | null = null;
  let stage: AuthStage | null = null;
  let error: string | null = null;
  let authorized: boolean | null = null;

  if (running) {
    const visible = await hardcopy();
    // The log's hyperlink copy stays complete and stable; the visible window gets
    // rewritten (and mangled) as the CLI re-renders, so only use it as a fallback.
    url = extractOauthUrl(log) ?? extractOauthUrl(visible);
    tail = lastLines(cleanTerminalText(visible), 8);
    error = screenError(visible);
    if (error) stage = "error";
    else if (codeSubmitted) stage = "checking";
    else if (/Paste code here/i.test(cleanTerminalText(visible))) stage = "awaiting_code";
    else stage = "starting";
    // The CLI may sit on a "you're signed in" screen instead of exiting — treat a
    // real login as success even while the screen is still up.
    if (stage === "checking") authorized = await cliLoggedIn();
  } else {
    // finished (or died) — surface the last output so failures aren't silent,
    // and check the CLI's real login state so the UI can report success honestly
    for (const file of authFiles ? [authFiles.hardcopy, authFiles.log] : []) {
      if (!tail) tail = lastLines(cleanTerminalText(readIfExists(file)), 8);
    }
    authorized = await cliLoggedIn();
  }
  await loginTracker.observe(authorized, log);
  return { running, url, tail, stage, error, authorized };
}

export async function submitCode(code: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^[\w#%.-]{4,200}$/.test(code)) return { ok: false, error: "That doesn't look like a code." };
  if (!(await authScreenAlive())) return { ok: false, error: "No login in progress — start again." };
  // The CLI's prompt is a full-screen TUI: a single write that ends in CR reads as a
  // paste, so the newline is absorbed into the pasted text and the code is typed but
  // never submitted. Sending Enter as its own write makes it register as a keypress.
  const typed = await run(["screen", "-S", AUTH_SCREEN, "-X", "stuff", code]);
  if (typed.code !== 0) return { ok: false, error: "Couldn't send the code." };
  await Bun.sleep(200);
  const entered = await run(["screen", "-S", AUTH_SCREEN, "-X", "stuff", "\r"]);
  if (entered.code !== 0) return { ok: false, error: "Couldn't submit the code." };
  codeSubmitted = true;
  return { ok: true };
}

export async function cancelAuth(): Promise<{ ok: true }> {
  await run(["screen", "-S", AUTH_SCREEN, "-X", "quit"]);
  codeSubmitted = false;
  loginTracker.cancel();
  removeAuthFiles();
  return { ok: true };
}
