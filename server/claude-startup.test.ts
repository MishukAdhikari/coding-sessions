import { expect, test } from "bun:test";
import { claudeStartupPrompt } from "./claude-startup";
import { SECURITY, THEME, TRUST } from "./claude-startup.fixtures";


test("Claude Code's first-run screens are recognised", () => {
  expect(claudeStartupPrompt(THEME)?.kind).toBe("theme");
  expect(claudeStartupPrompt(SECURITY)?.kind).toBe("security_notes");
  const trust = claudeStartupPrompt(TRUST);
  expect(trust?.kind).toBe("folder_trust");
  expect(trust?.question).toContain("No, exit");
  expect(trust?.how).toContain("[\"down\", \"enter\"]");
  expect(claudeStartupPrompt("\x1b[1m" + TRUST.replace(/\n/g, "\r\n"))?.kind).toBe("folder_trust");
});

test("an ordinary screen, or a first-run screen long scrolled away, is not a first-run prompt", () => {
  expect(claudeStartupPrompt("❯ ready")).toBeNull();
  expect(claudeStartupPrompt("● Is this a project you created or one you trust? is what it asks.\n❯ ")).toBeNull();
  expect(claudeStartupPrompt(TRUST + "\n" + Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"))).toBeNull();
});
