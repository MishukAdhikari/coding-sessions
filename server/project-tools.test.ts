import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, insideWorkspaces, removeProject, type ProjectToolDeps } from "./project-tools";
import { handleMcpPost, type McpDeps } from "./mcp";

function harness(over: Partial<ProjectToolDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "cs-proj-"));
  const ws = join(root, "workspaces");
  mkdirSync(ws);
  const rows: Array<{ id: number; path: string; label: string }> = [];
  const calls: string[] = [];
  const deps: ProjectToolDeps = {
    workspacesDir: ws,
    async prepare(name, repo, branch) {
      calls.push(`prepare ${name} ${repo} ${branch}`);
      const p = join(ws, `cs-${name}`);
      mkdirSync(p, { recursive: true });
      return { ok: true, workspacePath: p };
    },
    status: async () => ({ ok: true, state: "none" }),
    list: () => rows,
    insert: (path, label) => { if (!rows.some((r) => r.path === path)) rows.push({ id: rows.length + 1, path, label }); },
    remove: (id) => { const i = rows.findIndex((r) => r.id === id); if (i < 0) return false; rows.splice(i, 1); return true; },
    ...over,
  };
  return { deps, root, ws, rows, calls };
}

test("repo clones through the app's workspace preparation and registers the folder", async () => {
  const { deps, rows, calls, ws } = harness();
  const r = await addProject(deps, { repo: "me/app", name: "app", branch: "dev" });
  expect(r).toMatchObject({ ok: true, cloned: true, existed: false, project: { id: 1, label: "app" } });
  expect(calls).toEqual(["prepare app me/app dev"]);
  expect(rows[0]!.path.endsWith("/workspaces/cs-app")).toBe(true);
  expect(rows[0]!.path.startsWith(ws) || rows[0]!.path.includes("/workspaces/")).toBe(true);
});

test("repo needs a name and never overwrites a used workspace", async () => {
  const { deps, calls } = harness({ status: async () => ({ ok: true, state: "resumable" }) });
  expect(await addProject(deps, { repo: "me/app" })).toMatchObject({ ok: false, code: "invalid_argument" });
  expect(await addProject(deps, { repo: "me/app", name: "app" })).toMatchObject({ ok: false, code: "conflict" });
  expect(calls).toEqual([]);
});

test("path is accepted only inside the workspaces folder, symlinks resolved", async () => {
  const { deps, root, ws, rows } = harness();
  mkdirSync(join(ws, "handoff"));
  mkdirSync(join(root, "elsewhere"));
  symlinkSync(join(root, "elsewhere"), join(ws, "sneaky"));
  expect(await addProject(deps, { path: join(ws, "handoff") })).toMatchObject({ ok: true, cloned: false, project: { label: "handoff" } });
  expect(await addProject(deps, { path: join(ws, "handoff") })).toMatchObject({ ok: true, existed: true });
  expect(rows).toHaveLength(1);
  for (const path of [join(root, "elsewhere"), join(ws, "sneaky"), ws, "/etc", join(ws, "missing"), "relative/x", join(ws, "..", "elsewhere")]) {
    expect(await addProject(deps, { path })).toMatchObject({ ok: false, code: "invalid_argument" });
  }
  expect(await addProject(deps, { path: join(ws, "handoff"), repo: "me/app" })).toMatchObject({ ok: false });
  expect(insideWorkspaces(join(ws, "sneaky"), ws)).toBeNull();
});

test("remove_project forgets the row only", async () => {
  const { deps, ws, rows } = harness();
  mkdirSync(join(ws, "a"));
  await addProject(deps, { path: join(ws, "a") });
  expect(removeProject(deps, "x")).toMatchObject({ ok: false, code: "invalid_argument" });
  expect(removeProject(deps, 9)).toMatchObject({ ok: false, code: "not_found" });
  expect(removeProject(deps, 1)).toMatchObject({ ok: true, removed: { id: 1 } });
  expect(rows).toHaveLength(0);
});

test("MCP add_project returns the id and the next launch; tools carry the right annotations", async () => {
  const { deps } = harness();
  const mcp = {
    projects: deps, listSessions: async () => [], listArchive: () => [], hostStats: () => null, listProjects: () => deps.list(), listRepos: async () => [],
    providers: () => [], launch: async () => ({ ok: false, error: "x" }), end: async () => ({ ok: true }), resume: async () => ({ ok: true }),
    readScreen: async () => ({ ok: true, value: "" }), sendText: async () => ({ ok: true, value: true }), sendKeys: async () => ({ ok: true, value: true }),
    sleep: async () => {}, now: () => 0,
  } as McpDeps;
  const rpc = async (body: object) => (await (await handleMcpPost(mcp, new Request("https://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) }))).json()) as any;
  const r = await rpc({ method: "tools/call", params: { name: "add_project", arguments: { repo: "me/app", name: "app" } } });
  expect(r.result.structuredContent.project.id).toBe(1);
  expect(r.result.structuredContent.next).toContain('mode: "acp"');
  const bad = await rpc({ method: "tools/call", params: { name: "add_project", arguments: { path: "/etc" } } });
  expect(bad.result.structuredContent.error.code).toBe("invalid_argument");
  const tools = (await rpc({ method: "tools/list" })).result.tools;
  expect(tools.find((t: any) => t.name === "add_project").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  expect(tools.find((t: any) => t.name === "remove_project").annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
});
