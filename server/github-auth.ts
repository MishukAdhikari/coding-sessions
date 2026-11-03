import { childEnvironment } from "./child-env";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * GitHub access for sessions: the user pastes a personal access token once,
 * the server hands it to `gh auth login --with-token` as the service user and
 * wires git's credential helper (`gh auth setup-git`). Sessions then use gh
 * and https git remotes without any extra setup. The token lives only in gh's
 * own store (~/.config/gh/hosts.yml) — never in this app's database or logs.
 */

// gh token shapes (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_) plus legacy 40-hex.
const TOKEN_RE = /^(gh[pousr]_[A-Za-z0-9_]{16,255}|github_pat_[A-Za-z0-9_]{22,255}|[0-9a-f]{40})$/;

export function isPlausibleGithubToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

function ghBinary(): string | null {
  const bin = Bun.which("gh")
    ?? [join(homedir(), ".local", "bin", "gh"), "/usr/bin/gh", "/usr/local/bin/gh"].find(existsSync);
  return bin && existsSync(bin) ? bin : null;
}

async function runGh(args: string[], stdin?: string): Promise<{ code: number; text: string }> {
  const bin = ghBinary();
  if (!bin) return { code: 127, text: "gh not installed" };
  const p = Bun.spawn([bin, ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    // A stale GH_TOKEN/GITHUB_TOKEN in the service environment would override
    // the freshly stored login inside gh — keep these out of every gh call.
    env: childEnvironment({ GH_TOKEN: "", GITHUB_TOKEN: "" }),
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, text: (out + "\n" + err).trim() };
}

export interface GithubAuthStatus {
  installed: boolean;
  authenticated: boolean;
  account: string | null;
}

export async function githubStatus(): Promise<GithubAuthStatus> {
  if (!ghBinary()) return { installed: false, authenticated: false, account: null };
  const { code, text } = await runGh(["auth", "status", "--hostname", "github.com"]);
  const authenticated = code === 0 && /Logged in to github\.com/i.test(text);
  const account = text.match(/account\s+(\S+)/i)?.[1] ?? null;
  return { installed: true, authenticated, account: authenticated ? account : null };
}

export async function saveGithubToken(token: string): Promise<{ ok: boolean; error?: string; account?: string | null }> {
  if (!isPlausibleGithubToken(token)) {
    return { ok: false, error: "That doesn't look like a GitHub token (expected ghp_…, github_pat_…, or a 40-char classic token)." };
  }
  if (!ghBinary()) {
    return { ok: false, error: "The GitHub CLI (gh) is not installed on the server. Install it (apt install gh) and try again." };
  }
  const login = await runGh(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], token + "\n");
  if (login.code !== 0) {
    // gh prints the reason (bad token, missing scopes) — pass it through, it never echoes the token
    return { ok: false, error: login.text || "gh rejected the token." };
  }
  await runGh(["auth", "setup-git", "--hostname", "github.com"]); // best-effort: https git remotes use gh as credential helper
  const status = await githubStatus();
  return { ok: true, account: status.account };
}

export async function removeGithubAuth(): Promise<{ ok: boolean; error?: string }> {
  if (!ghBinary()) return { ok: false, error: "The GitHub CLI (gh) is not installed on the server." };
  const { code, text } = await runGh(["auth", "logout", "--hostname", "github.com"]);
  if (code !== 0 && !/not logged in/i.test(text)) return { ok: false, error: text || "gh logout failed." };
  return { ok: true };
}
