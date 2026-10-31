import { test, expect } from "bun:test";
import { lastTurnState } from "./turn-state";

/** Build one transcript line (a JSON object per line, like Claude Code writes). */
const line = (o: unknown) => JSON.stringify(o);

const assistant = (stop_reason: string, content: unknown[] = []) =>
  line({ type: "assistant", message: { stop_reason, content } });
const toolUse = (name: string) =>
  assistant("tool_use", [{ type: "tool_use", name }]);
const userMsg = () => line({ type: "user", message: { content: "hi" } });

test("assistant finished its turn (end_turn) → done", () => {
  expect(lastTurnState(assistant("end_turn"))).toBe("done");
});

test("stop_sequence also counts as done", () => {
  expect(lastTurnState(assistant("stop_sequence"))).toBe("done");
});

test("AskUserQuestion tool_use with no reply → asking", () => {
  expect(lastTurnState(toolUse("AskUserQuestion"))).toBe("asking");
});

test("ExitPlanMode (plan approval) → asking", () => {
  expect(lastTurnState(toolUse("ExitPlanMode"))).toBe("asking");
});

test("an auto-running tool (Bash) → busy", () => {
  expect(lastTurnState(toolUse("Bash"))).toBe("busy");
});

test("last real entry is a user message → busy (Claude's turn)", () => {
  const tail = [assistant("end_turn"), userMsg()].join("\n");
  expect(lastTurnState(tail)).toBe("busy");
});

test("a leading truncated/garbage line is skipped; classifies on the last real turn", () => {
  const tail = ['{"type":"assist', assistant("end_turn")].join("\n");
  expect(lastTurnState(tail)).toBe("done");
});

test("blank lines between entries are ignored", () => {
  const tail = ["", assistant("tool_use", [{ type: "tool_use", name: "ExitPlanMode" }]), ""].join("\n");
  expect(lastTurnState(tail)).toBe("asking");
});

test("empty tail / no assistant-or-user lines → unknown", () => {
  expect(lastTurnState("")).toBe("unknown");
  expect(lastTurnState('{"type":"system","subtype":"init"}')).toBe("unknown");
});

test("mixed tool_use block: AskUserQuestion alongside another tool still → asking", () => {
  const tail = assistant("tool_use", [
    { type: "text", text: "let me ask" },
    { type: "tool_use", name: "AskUserQuestion" },
  ]);
  expect(lastTurnState(tail)).toBe("asking");
});
