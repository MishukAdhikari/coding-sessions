import { describe, expect, test } from "bun:test";
import { MAX_COMMANDS, sanitizeCommands } from "./commands";

describe("advertised slash commands", () => {
  test("keeps name, description and the input hint", () => {
    expect(sanitizeCommands([
      { name: "review", description: "Review the current changes", input: { hint: "what to focus on" } },
      { name: "init", description: "Write a CLAUDE.md", input: null },
      { name: "compound-engineering:ce-plan", description: "Plan the work", _meta: { skillPath: "/x/SKILL.md" } },
    ])).toEqual([
      { name: "review", description: "Review the current changes", hint: "what to focus on" },
      { name: "init", description: "Write a CLAUDE.md", hint: null },
      { name: "compound-engineering:ce-plan", description: "Plan the work", hint: null },
    ]);
  });

  test("drops names the composer could not insert as /name, and duplicates", () => {
    const kept = sanitizeCommands([
      { name: "two words", description: "x" }, { name: "<b>", description: "x" }, { name: "", description: "x" },
      { name: "/web", description: "a leading slash is tolerated" }, { name: "web", description: "duplicate" },
      null, "review", { description: "no name" },
    ]);
    expect(kept.map((c) => c.name)).toEqual(["web"]);
    expect(kept[0]?.description).toBe("a leading slash is tolerated");
  });

  test("caps the count and the text it keeps", () => {
    const many = Array.from({ length: MAX_COMMANDS + 50 }, (_, i) => ({ name: `c${i}`, description: "d".repeat(1000), input: { hint: "h".repeat(500) } }));
    const kept = sanitizeCommands(many);
    expect(kept).toHaveLength(MAX_COMMANDS);
    expect(kept[0]!.description.length).toBeLessThanOrEqual(300);
    expect(kept[0]!.hint!.length).toBeLessThanOrEqual(120);
  });

  test("anything that is not a list is no commands", () => {
    expect(sanitizeCommands(undefined)).toEqual([]);
    expect(sanitizeCommands({ name: "review" })).toEqual([]);
  });
});
