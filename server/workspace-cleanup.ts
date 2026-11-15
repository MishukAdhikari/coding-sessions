import { join } from "node:path";
import { commandCodeProjectDirName } from "./command-code";

const DELETED_SUFFIX = " (deleted)";

/** Is `cwd` the workspace or inside it? Linux reports a removed folder as "<path> (deleted)". */
export function isInsideWorkspace(workspace: string, cwd: string | null): boolean {
  if (!cwd) return false;
  const path = cwd.endsWith(DELETED_SUFFIX) ? cwd.slice(0, -DELETED_SUFFIX.length) : cwd;
  return path === workspace || path.startsWith(workspace + "/");
}

/** What agents keep about a folder outside it: Claude's history and logs, Command Code's history. */
export function agentStatePaths(workspace: string, home: string): string[] {
  const claudeName = workspace.replace(/[^a-zA-Z0-9]/g, "-");
  return [
    join(home, ".claude", "projects", claudeName),
    join(home, ".cache", "claude-cli-nodejs", claudeName),
    join(home, ".commandcode", "projects", commandCodeProjectDirName(workspace)),
  ];
}

/**
 * The agent state that belongs to `workspace` alone. Agents name a folder's state by
 * flattening its path, so `my_app` and `my-app` share one directory: state another
 * folder in `others` also maps to is left, or deleting one workspace wipes its
 * neighbour's history.
 */
export function unsharedAgentStatePaths(workspace: string, others: Iterable<string>, home: string): string[] {
  const shared = new Set<string>();
  for (const other of others) if (other !== workspace) for (const path of agentStatePaths(other, home)) shared.add(path);
  return agentStatePaths(workspace, home).filter((path) => !shared.has(path));
}
