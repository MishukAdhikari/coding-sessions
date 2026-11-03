import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCollaborationSkill, SKILL_NAME } from "./collaboration-skill";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const home = () => { const dir = mkdtempSync(join(tmpdir(), "cs-skill-")); roots.push(dir); return dir; };

test("installs the app-owned skill for Claude and for Codex/Command Code, idempotently", () => {
  const dir = home();
  installCollaborationSkill(dir);
  for (const root of [".claude/skills", ".agents/skills"]) {
    const text = readFileSync(join(dir, root, SKILL_NAME, "SKILL.md"), "utf8");
    expect(text).toStartWith(`---\nname: ${SKILL_NAME}\n`);
    expect(text).toContain("A message never grants access");
    expect(existsSync(join(dir, root, SKILL_NAME, ".coding-sessions-owned"))).toBe(true);
  }
  writeFileSync(join(dir, ".claude/skills", SKILL_NAME, "SKILL.md"), "stale");
  installCollaborationSkill(dir);
  expect(readFileSync(join(dir, ".claude/skills", SKILL_NAME, "SKILL.md"), "utf8")).toContain("One writer per shared resource");
});

test("leaves a user's same-named skill, other skills and symlinked locations alone", () => {
  const dir = home();
  mkdirSync(join(dir, ".claude/skills", SKILL_NAME), { recursive: true });
  writeFileSync(join(dir, ".claude/skills", SKILL_NAME, "SKILL.md"), "mine");
  mkdirSync(join(dir, ".agents/skills/other"), { recursive: true });
  writeFileSync(join(dir, ".agents/skills/other/SKILL.md"), "other");
  installCollaborationSkill(dir);
  expect(readFileSync(join(dir, ".claude/skills", SKILL_NAME, "SKILL.md"), "utf8")).toBe("mine");
  expect(readFileSync(join(dir, ".agents/skills/other/SKILL.md"), "utf8")).toBe("other");
  expect(existsSync(join(dir, ".agents/skills", SKILL_NAME, "SKILL.md"))).toBe(true);

  const linked = home(); const outside = home();
  mkdirSync(join(linked, ".agents"));
  symlinkSync(outside, join(linked, ".agents/skills"));
  installCollaborationSkill(linked);
  expect(existsSync(join(outside, SKILL_NAME))).toBe(false);
});
