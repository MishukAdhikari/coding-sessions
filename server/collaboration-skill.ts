import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const SKILL_NAME = "coding-sessions-collaboration";
const MARKER = ".coding-sessions-owned";
const SOURCE = new URL(`./skills/${SKILL_NAME}/SKILL.md`, import.meta.url);
/** Claude reads ~/.claude/skills; Codex and Command Code read ~/.agents/skills. */
const ROOTS = [[".claude", "skills"], [".agents", "skills"]];

const isDirectory = (path: string) => { try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; } };
const isFile = (path: string) => { try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; } };
function readSmall(path: string): string | null {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const stat = fstatSync(fd); return stat.isFile() && stat.size < 256 * 1024 ? readFileSync(fd, "utf8") : null; } finally { closeSync(fd); }
  } catch { return null; }
}

/**
 * Install or refresh the app-owned skill. A folder of that name without the marker is the
 * user's and is left alone; symlinks anywhere on the path are refused. Never throws.
 */
export function installCollaborationSkill(home = homedir()): void {
  let content: string;
  try { content = readFileSync(SOURCE, "utf8"); } catch { return; }
  for (const parts of ROOTS) {
    try {
      let directory = home;
      for (const part of [...parts, SKILL_NAME]) {
        const next = join(directory, part);
        try { mkdirSync(next, { mode: 0o700 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (part === SKILL_NAME && !isFile(join(next, MARKER))) throw new Error("user-owned");
        }
        if (!isDirectory(next)) throw new Error("not a plain directory");
        directory = next;
      }
      const marker = join(directory, MARKER);
      const file = join(directory, "SKILL.md");
      if (isFile(marker) && readSmall(file) === content) continue;
      if (lstatSync(directory).isSymbolicLink()) continue;
      for (const [path, text] of [[file, content], [marker, "1\n"]] as const) {
        const temporary = join(directory, `.${randomUUID()}.tmp`);
        try { writeFileSync(temporary, text, { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
        finally { rmSync(temporary, { force: true }); }
      }
    } catch { /* A missing or user-owned skill location never blocks a launch. */ }
  }
}
