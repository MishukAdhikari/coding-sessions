import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeOnboardingDone, completeClaudeOnboarding, runDoctor, type DoctorDeps } from "./server-setup";
import { handleMcpPost, type McpDeps, type SetupDeps } from "./mcp";
import { LiveFeed } from "./live";

const home = () => mkdtempSync(join(tmpdir(), "cs-setup-"));

test("completing Claude Code onboarding keeps every other key and is idempotent", () => {
  const h = home();
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ projects: { "/x": { hasTrustDialogAccepted: true } }, userID: "u" }));
  expect(claudeOnboardingDone(h)).toBe(false);
  expect(completeClaudeOnboarding(h)).toEqual({ ok: true, changed: true });
  const state = JSON.parse(readFileSync(join(h, ".claude.json"), "utf8"));
  expect(state).toMatchObject({ hasCompletedOnboarding: true, theme: "dark", userID: "u", projects: { "/x": { hasTrustDialogAccepted: true } } });
  expect(statSync(join(h, ".claude.json")).mode & 0o777).toBe(0o600);
  expect(completeClaudeOnboarding(h)).toEqual({ ok: true, changed: false });
  expect(claudeOnboardingDone(h)).toBe(true);
});

test("onboarding refuses to overwrite a state file it cannot parse", () => {
  const h = home();
  writeFileSync(join(h, ".claude.json"), "{not json");
  expect(completeClaudeOnboarding(h).ok).toBe(false);
  expect(readFileSync(join(h, ".claude.json"), "utf8")).toBe("{not json");
});

const doctorDeps = (h: string, over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  home: h, uid: process.getuid!(), which: () => "/usr/bin/x",
  host: () => ({ diskFreeGb: 20, memTotalGb: 4 }), browserInstalled: () => true,
  claudeInstalled: () => true, claudeVersion: () => null, ...over,
});

test("doctor reports onboarding and repairs it only with fix; root-only items carry the sudo command", () => {
  const h = home();
  const before = runDoctor(doctorDeps(h, { which: (b) => (b === "ttyd" ? null : "/usr/bin/" + b) }), false);
  expect(before.find((f) => f.check === "Claude Code onboarding")).toMatchObject({ status: "warn", fix: "doctor {fix: true}" });
  expect(before.find((f) => f.check.startsWith("ttyd"))).toMatchObject({ status: "fail", human: true, fix: "sudo coding-sessions setup" });
  const after = runDoctor(doctorDeps(h), true);
  expect(after.find((f) => f.check === "Claude Code onboarding")).toMatchObject({ status: "ok", repaired: true });
  expect(claudeOnboardingDone(h)).toBe(true);
});

test("doctor flags files another user owns with the root repair command", () => {
  const h = home();
  const findings = runDoctor(doctorDeps(h, { uid: process.getuid!() + 1 }), false);
  // The temp home itself belongs to this test's user, so with another uid every present path is foreign.
  writeFileSync(join(h, ".claude.json"), "{}");
  const again = runDoctor(doctorDeps(h, { uid: process.getuid!() + 1 }), false);
  expect(findings.some((f) => f.fix === "sudo coding-sessions doctor --fix")).toBe(false);
  expect(again.find((f) => f.check === "owner of ~/.claude.json")).toMatchObject({ status: "fail", human: true, fix: "sudo coding-sessions doctor --fix" });
});

/* ---------- MCP tools ---------- */

function setupDeps(over: Partial<SetupDeps> = {}) {
  const calls: string[] = [];
  let trust = false;
  const setup: SetupDeps = {
    snapshot: async () => ({
      app: { version: "0.15.0", channel: "releases", auto_updates: true },
      permissions: "standard",
      trust_workspaces: { enabled: trust },
      agents: [
        { id: "claude", label: "Claude Code", installed: true, version: "2.1.0", signed_in: false, acp_adapter: false },
        { id: "codex", label: "Codex", installed: false, version: null, signed_in: null, acp_adapter: false },
      ],
      claude_onboarding: false, browser: true, host: { diskFreeGb: 20 },
    }),
    install: (agents) => { calls.push(`install ${JSON.stringify(agents)}`); return { ok: true, job: { agents: ["claude"], running: false, result: "success", startedAt: "s", finishedAt: "f", output: "" } }; },
    job: () => null,
    doctor: (fix) => { calls.push(`doctor ${fix}`); return [{ check: "Claude Code onboarding", status: fix ? "ok" : "warn", detail: "", fix: "doctor {fix: true}" }]; },
    setTrust: (on) => { calls.push(`trust ${on}`); trust = on; return { ok: true }; },
    ...over,
  };
  return { setup, calls };
}

function deps(setup: SetupDeps, screen = "❯ ready"): McpDeps {
  let clock = 0;
  return {
    setup,
    listSessions: async () => [{ id: "m:cs-h", kind: "managed", provider: "claude", launchId: null, phase: null, errorMessage: null, name: "h", status: "running", workspace: true, project: "/w", projectLabel: null, pid: 1, uptimeSec: 1, cpu: 0, active: false, busy: false, waiting: false, asking: false, telemetryUnknown: false, claudeUrl: null, remoteControl: true, resumeId: null, model: null, initial: "H" } as any],
    listArchive: () => [], hostStats: () => null, listProjects: () => [], listRepos: async () => [],
    providers: () => [{ id: "claude", name: "Claude", remoteControl: true, turnState: true }],
    launch: async () => ({ ok: false, error: "x" }), end: async () => ({ ok: true }), resume: async () => ({ ok: true }),
    readScreen: async () => ({ ok: true, value: screen }), sendText: async () => ({ ok: true, value: true }), sendKeys: async () => ({ ok: true, value: true }),
    sleep: async (ms) => { clock += ms; }, now: () => clock,
  };
}

const call = async (d: McpDeps, name: string, args: object = {}) => {
  const res = await handleMcpPost(d, new Request("https://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
  return ((await res.json()) as any).result;
};

const TRUST_SCREEN = "Is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit";

test("server_status lists what is missing with the next call, separating human-only items", async () => {
  const { setup } = setupDeps();
  const r = await call(deps(setup, TRUST_SCREEN), "server_status");
  const s = r.structuredContent;
  expect(s.ready).toBe(false);
  const by = (item: string) => s.missing.find((m: any) => m.item === item);
  expect(by("Claude Code Chat (ACP) adapter").next).toBe('setup_agents {agents: ["claude-acp"]}');
  expect(by("Claude Code sign-in")).toMatchObject({ human: true });
  expect(by("Claude Code onboarding").next).toBe("doctor {fix: true}");
  expect(by("workspace trust")).toMatchObject({ ask_operator: true });
  expect(by("session h: folder_trust")).toMatchObject({ ask_operator: true });
  expect(s.startup_screens).toEqual([expect.objectContaining({ session_id: "m:cs-h", kind: "folder_trust" })]);
  expect(JSON.stringify(s)).not.toMatch(/https?:\/\//);
});

test("trust_workspaces refuses without confirm and records the operator's yes", async () => {
  const { setup, calls } = setupDeps();
  const d = deps(setup);
  const refused = await call(d, "trust_workspaces", { enabled: true });
  expect(refused.isError).toBe(true);
  expect(refused.structuredContent.error.next).toContain("Ask the human");
  expect(calls).toEqual([]);
  expect((await call(d, "trust_workspaces", { enabled: true, confirm: true })).structuredContent.trust_workspaces).toBe(true);
  expect((await call(d, "trust_workspaces", { enabled: false })).structuredContent.trust_workspaces).toBe(false);
  expect(calls).toEqual(["trust true", "trust false"]);
});

test("setup_agents starts a job and reports a running one as a conflict", async () => {
  const { setup, calls } = setupDeps();
  const r = await call(deps(setup), "setup_agents", { agents: ["claude"] });
  expect(r.structuredContent.job.result).toBe("success");
  expect(calls).toEqual(['install ["claude"]']);
  const busy = setupDeps({ install: () => ({ ok: false, error: "Already installing claude.", status: 409 }) });
  expect((await call(deps(busy.setup), "setup_agents", { agents: ["codex"] })).structuredContent.error.code).toBe("conflict");
});

test("doctor passes fix through", async () => {
  const { setup, calls } = setupDeps();
  const r = await call(deps(setup), "doctor", { fix: true });
  expect(r.structuredContent.ok).toBe(true);
  expect(calls).toEqual(["doctor true"]);
});

test("tools are unavailable without setup deps", async () => {
  const d = deps(setupDeps().setup);
  delete d.setup;
  expect((await call(d, "server_status")).structuredContent.error.code).toBe("unavailable");
});

/* ---------- cs live ---------- */

test("cs live shows a Claude Code first-run screen once, as a question", () => {
  const feed = new LiveFeed("m:cs-h");
  const view = { id: "m:cs-h", name: "h", provider: "claude", mode: "terminal", activity: "running", asking: false, prs: [] };
  const read = () => ({ frames: [], cursor: 0, reset: false });
  const screen = { kind: "theme", question: "Claude Code's first-run theme picker", how: 'press_keys ["enter"]' };
  const first = feed.step(view, read, [], screen).frames.filter((f) => f.type === "ask");
  expect(first).toHaveLength(1);
  expect((first[0] as any).text).toContain("first-run screen");
  expect(feed.step(view, read, [], screen).frames.filter((f) => f.type === "ask")).toHaveLength(0);
  expect(feed.step(view, read, [], { ...screen, kind: "folder_trust" }).frames.filter((f) => f.type === "ask")).toHaveLength(1);
});
