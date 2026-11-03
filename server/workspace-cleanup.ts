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
