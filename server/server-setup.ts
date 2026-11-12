/**
 * Server setup from an operator's agent: what a fresh server still needs, the non-root
 * checks and repairs the service account can make itself, and Claude Code's first-run
 * onboarding. Used by the MCP tools server_status, doctor and setup_agents, so a local
 * agent can take a new server to working without SSH.
 *
 * Nothing here runs as root, reads a secret's value, or returns a sign-in link: sign-in
 * stays with agent_auth, secrets with request_secret, root repairs with the human
 * (the exact `sudo coding-sessions …` command is returned instead).
 */
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/* ---------- Claude Code's first-run onboarding ---------- */

/** ~/.claude.json, Claude Code's own state file for this account. */
export const claudeStateFile = (home = homedir()) => join(home, ".claude.json");

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** Whether Claude Code's theme picker and security notes were already passed for this account. */
export function claudeOnboardingDone(home = homedir()): boolean {
  return readJson(claudeStateFile(home))?.hasCompletedOnboarding === true;
}

/**
 * Pass Claude Code's first-run onboarding for this account (theme picker, security
 * notes) without a terminal: the same flags Claude Code writes when a person finishes
 * it. Folder trust is not touched here; that is the trust_workspaces setting.
 * Keeps every other key; refuses to replace a file it cannot parse.
 */
export function completeClaudeOnboarding(home = homedir(), version: string | null = null): { ok: true; changed: boolean } | { ok: false; error: string } {
  const file = claudeStateFile(home);
  let state: Record<string, unknown> = {};
  if (existsSync(file)) {
    const parsed = readJson(file);
    if (!parsed) return { ok: false, error: `${file} is not valid JSON; Claude Code would not read it either. Move it aside and start Claude Code once.` };
    if (lstatSync(file).isSymbolicLink()) return { ok: false, error: `${file} is a symlink; refusing to write through it.` };
    state = parsed;
  }
  if (state.hasCompletedOnboarding === true && typeof state.theme === "string") return { ok: true, changed: false };
  state.hasCompletedOnboarding = true;
  if (typeof state.theme !== "string") state.theme = "dark";
  if (version && typeof state.lastOnboardingVersion !== "string") state.lastOnboardingVersion = version;
  const tmp = `${file}.cs-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  return { ok: true, changed: true };
}

/* ---------- doctor: non-root checks and repairs ---------- */

export type FindingStatus = "ok" | "warn" | "fail";

export interface Finding {
  check: string;
  status: FindingStatus;
  detail: string;
  /** What fixes it: an MCP call, or the exact root command for a human. */
  fix?: string;
  /** Only a person can do it (root on the server, a sign-in, a secret value). */
  human?: boolean;
  /** doctor {fix: true} repaired it. */
  repaired?: boolean;
}

export interface DoctorDeps {
  home: string;
  uid: number;
  which(name: string): string | null;
  host(): { diskFreeGb: number; memTotalGb: number } | null;
  /** Playwright's Chromium for the Claude.ai browser sign-in. */
  browserInstalled(): boolean;
  claudeInstalled(): boolean;
  claudeVersion(): string | null;
}

export const ROOT_DOCTOR = "sudo coding-sessions doctor --fix";

/** Files under `dir` (bounded walk) that this account does not own: only root can give them back. */
function foreignFiles(dir: string, uid: number, limit = 4000): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (path: string, depth: number) => {
    if (out.length >= 5 || seen >= limit) return;
    let st;
    try { st = lstatSync(path); } catch { return; }
    seen++;
    if (st.uid !== uid) { out.push(path); return; }
    if (!st.isDirectory() || st.isSymbolicLink() || depth > 4) return;
    let names: string[] = [];
    try { names = readdirSync(path); } catch { return; }
    for (const name of names) {
      if (name === "node_modules" && depth > 1) continue;
      walk(join(path, name), depth + 1);
    }
  };
  if (existsSync(dir)) walk(dir, 0);
  return out;
}

/** The checks the service account can run on itself; with `fix`, the repairs it can make. */
export function runDoctor(deps: DoctorDeps, fix: boolean): Finding[] {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  // Ownership: npm, the Claude installer and the agents write here as this account.
  for (const rel of [".local", ".claude", ".codex", ".claude.json", "workspaces"]) {
    const foreign = foreignFiles(join(deps.home, rel), deps.uid);
    if (foreign.length) add({ check: `owner of ~/${rel}`, status: "fail", detail: `Not owned by the service account: ${foreign.join(", ")}. Installs and agents fail with EACCES.`, fix: ROOT_DOCTOR, human: true });
  }
  if (!findings.length) add({ check: "file owners in the service home", status: "ok", detail: "~/.local, ~/.claude, ~/.codex and ~/workspaces belong to the service account." });

  // ~/.claude.json holds Claude Code's state and per-folder trust: private to the account.
  const state = claudeStateFile(deps.home);
  if (existsSync(state)) {
    const st = lstatSync(state);
    if (st.uid === deps.uid && !st.isSymbolicLink() && (st.mode & 0o077)) {
      if (fix) { try { chmodSync(state, 0o600); add({ check: "~/.claude.json mode", status: "ok", detail: "Made private (0600).", repaired: true }); } catch { add({ check: "~/.claude.json mode", status: "fail", detail: "Could not make it private.", fix: ROOT_DOCTOR, human: true }); } }
      else add({ check: "~/.claude.json mode", status: "warn", detail: `Readable by others (${(st.mode & 0o777).toString(8)}).`, fix: "doctor {fix: true}" });
    }
  }

  // Claude Code's first-run screens block every first session in a terminal.
  if (deps.claudeInstalled()) {
    if (claudeOnboardingDone(deps.home)) add({ check: "Claude Code onboarding", status: "ok", detail: "Theme and security notes are done; new sessions start at the prompt." });
    else if (fix) {
      const r = completeClaudeOnboarding(deps.home, deps.claudeVersion());
      add(r.ok ? { check: "Claude Code onboarding", status: "ok", detail: "Completed the first-run onboarding (theme, security notes) for the service account.", repaired: true }
        : { check: "Claude Code onboarding", status: "fail", detail: r.error });
    } else add({ check: "Claude Code onboarding", status: "warn", detail: "Not done: the first terminal session stops at the theme picker and security notes.", fix: "doctor {fix: true}" });
  }

  // Root-only system pieces the installer puts in place.
  for (const [bin, what] of [["screen", "screen (sessions run in it)"], ["ttyd", "ttyd (the web terminal)"], ["git", "git"]] as const) {
    if (!deps.which(bin)) add({ check: what, status: "fail", detail: `${bin} is not installed.`, fix: "sudo coding-sessions setup", human: true });
  }

  const host = deps.host();
  if (host) {
    add(host.diskFreeGb >= 5 ? { check: "free disk", status: "ok", detail: `${host.diskFreeGb} GB free.` }
      : { check: "free disk", status: "fail", detail: `${host.diskFreeGb} GB free; new sessions are refused under 5 GB.`, fix: "Free some space on the server.", human: true });
    if (host.memTotalGb < 2) add({ check: "memory", status: "warn", detail: `${host.memTotalGb} GB RAM; agents need about 2 GB.`, fix: "sudo coding-sessions setup --swap", human: true });
  }

  if (!deps.browserInstalled()) add({ check: "Claude.ai browser", status: "warn", detail: "Playwright Chromium is not installed (only needed for the Claude.ai browser sign-in).", fix: "sudo coding-sessions browser install", human: true });
  return findings;
}

/** Playwright keeps its browsers under ~/.cache/ms-playwright/chromium-*. */
export function playwrightChromium(home = homedir()): boolean {
  try { return readdirSync(join(home, ".cache", "ms-playwright")).some((n) => n.startsWith("chromium")); } catch { return false; }
}
