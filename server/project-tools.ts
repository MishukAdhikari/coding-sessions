/**
 * Projects from an operator's agent (MCP add_project / remove_project), so Chat (ACP)
 * mode, which launches only into a project, needs no browser on a fresh server.
 *
 * Narrower than the app's Projects sheet on purpose: an agent may register only folders
 * under the workspaces root (~/workspaces), either one the app already created or a fresh
 * clone made by the app's own workspace path (prepareSynced: same name rules, repo parsing,
 * disk check and git/GitHub credentials as a repo launch or a handoff). Every folder then
 * goes through validateProjectPath, the app's own add-project check. Arbitrary paths are
 * refused. Removing a project forgets the row; the folder and its files stay.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { validateProjectPath, type ProjectPathResult } from "./project-path";

export interface ProjectToolDeps {
  workspacesDir: string;
  /** The app's workspace preparation (clone at a branch); never overwrites a live or existing workspace here. */
  prepare(name: string, repo: string, branch: string | null): Promise<{ ok: true; workspacePath: string } | { ok: false; error: string }>;
  /** Whether a workspace or session already uses this name. */
  status(name: string): Promise<{ ok: true; state: "live" | "resumable" | "none" } | { ok: false; error: string }>;
  validate?(path: string): ProjectPathResult;
  list(): Array<{ id: number; path: string; label: string }>;
  insert(path: string, label: string): void;
  remove(id: number): boolean;
}

export type ProjectResult =
  | { ok: true; project: { id: number; path: string; label: string }; cloned: boolean; existed: boolean }
  | { ok: false; error: string; code: "invalid_argument" | "not_found" | "conflict" | "failed" };

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$/;

/** The real path of `p` when it is a folder strictly inside the workspaces root, else null (symlinks resolved). */
export function insideWorkspaces(p: string, root: string): string | null {
  let real: string, realRoot: string;
  try { real = realpathSync(normalize(p)); realRoot = realpathSync(root); } catch { return null; }
  return real.startsWith(realRoot + "/") ? real : null;
}

export async function addProject(deps: ProjectToolDeps, args: { repo?: unknown; path?: unknown; name?: unknown; branch?: unknown; label?: unknown }): Promise<ProjectResult> {
  const repo = typeof args.repo === "string" ? args.repo.trim() : "";
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  if (!!repo === !!rawPath) return { ok: false, code: "invalid_argument", error: "Give repo (to clone into a new workspace) or path (an existing folder under ~/workspaces), not both." };
  const labelIn = typeof args.label === "string" ? args.label.trim().slice(0, 60) : "";
  const validate = deps.validate ?? ((p: string) => validateProjectPath(p, false));
  let folder: string;
  let cloned = false;

  if (repo) {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!NAME_RE.test(name)) return { ok: false, code: "invalid_argument", error: "name is required with repo: 1-31 letters, numbers, dashes or underscores; it names the workspace folder." };
    const st = await deps.status(name);
    if (!st.ok) return { ok: false, code: "invalid_argument", error: st.error };
    if (st.state !== "none") return { ok: false, code: "conflict", error: `“${name}” already has a ${st.state === "live" ? "running session" : "workspace"}. Pick another name, or add that folder with path.` };
    const branch = typeof args.branch === "string" && args.branch.trim() ? args.branch.trim() : null;
    const prep = await deps.prepare(name, repo, branch);
    if (!prep.ok) return { ok: false, code: "failed", error: prep.error };
    folder = prep.workspacePath;
    cloned = true;
  } else {
    if (!rawPath.startsWith("/") && !rawPath.startsWith("~/")) return { ok: false, code: "invalid_argument", error: "path must be absolute, under the workspaces folder." };
    const abs = rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : rawPath;
    const inside = insideWorkspaces(abs, deps.workspacesDir);
    if (!inside) return { ok: false, code: "invalid_argument", error: `Only an existing folder under ${deps.workspacesDir} can be added over MCP. Other folders are added in the app (Projects).` };
    folder = inside;
  }

  const checked = validate(folder);
  if (!checked.ok) return { ok: false, code: "invalid_argument", error: checked.error };
  const existed = deps.list().some((p) => p.path === checked.path);
  deps.insert(checked.path, labelIn || (typeof args.name === "string" && args.name.trim()) || checked.path.split("/").pop() || checked.path);
  const project = deps.list().find((p) => p.path === checked.path);
  if (!project) return { ok: false, code: "failed", error: "The project could not be saved." };
  return { ok: true, project, cloned, existed };
}

export function removeProject(deps: Pick<ProjectToolDeps, "list" | "remove">, id: unknown): ProjectResult | { ok: true; removed: { id: number; path: string; label: string } } {
  const n = Number(id);
  if (!Number.isInteger(n)) return { ok: false, code: "invalid_argument", error: "project_id must be an integer from list_projects." };
  const project = deps.list().find((p) => p.id === n);
  if (!project) return { ok: false, code: "not_found", error: `No project with id ${n}.` };
  deps.remove(n);
  return { ok: true, removed: project };
}
