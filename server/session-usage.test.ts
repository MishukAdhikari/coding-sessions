import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDatabaseSchema } from "./db-schema";
import { claudeUsage, codexUsage, createBudgets, createUsageReader, parseBudget } from "./session-usage";

const claudeLine = (id: string, usage: Record<string, number>, type = "assistant") =>
  JSON.stringify({ type, uuid: `u-${id}-${Math.random()}`, message: { id, role: "assistant", usage } }) + "\n";
const codexLine = (input: number, cached: number, output: number) =>
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } } }) + "\n";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "cs-usage-"));
  return { file: join(dir, "t.jsonl"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a Claude message counts once, however many lines repeat it, and cache reads stay apart", () => {
  const t = scratch();
  try {
    writeFileSync(t.file,
      claudeLine("msg_1", { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 5000, output_tokens: 20 }) +
      claudeLine("msg_1", { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 5000, output_tokens: 45 }) +
      JSON.stringify({ type: "user", message: { role: "user", content: 'mentions "usage" in passing' } }) + "\n" +
      claudeLine("msg_2", { input_tokens: 3, cache_read_input_tokens: 7000, output_tokens: 7 }));
    const reader = createUsageReader();
    expect(reader.read(t.file, "claude")).toEqual({ tokens: 155, input: 103, output: 52, cached: 12000 });
    appendFileSync(t.file, claudeLine("msg_3", { input_tokens: 1, output_tokens: 4 }));
    expect(reader.read(t.file, "claude")).toEqual({ tokens: 160, input: 104, output: 56, cached: 12000 });
  } finally { t.done(); }
});

test("a Codex rollout's last running total wins, and a resumed run adds to the earlier one", () => {
  const t = scratch();
  try {
    writeFileSync(t.file, codexLine(1000, 400, 50) + codexLine(3000, 1000, 200));
    const reader = createUsageReader();
    expect(reader.read(t.file, "codex")).toEqual({ tokens: 2200, input: 2000, output: 200, cached: 1000 });
    appendFileSync(t.file, codexLine(500, 100, 10)); // resumed: Codex counts from zero again
    expect(reader.read(t.file, "codex")).toEqual({ tokens: 2610, input: 2400, output: 210, cached: 1100 });
  } finally { t.done(); }
});

test("a long transcript catches up over several polls, with no line lost at a read's edge", () => {
  const t = scratch();
  try {
    let text = "";
    for (let i = 0; i < 400; i++) text += claudeLine(`msg_${i}`, { input_tokens: 1, output_tokens: 1 }) + JSON.stringify({ type: "user", pad: "é".repeat(300) }) + "\n";
    writeFileSync(t.file, text);
    const reader = createUsageReader({ maxPerRead: 64 * 1024 });
    let usage = reader.read(t.file, "claude");
    expect(usage).toBeNull();
    for (let i = 0; i < 50 && !usage; i++) usage = reader.read(t.file, "claude");
    expect(usage).toEqual({ tokens: 800, input: 400, output: 400, cached: 0 });
  } finally { t.done(); }
});

test("a transcript that shrank or went away starts over or reads as nothing", () => {
  const t = scratch();
  try {
    writeFileSync(t.file, claudeLine("a", { input_tokens: 5, output_tokens: 5 }) + claudeLine("b", { input_tokens: 5, output_tokens: 5 }));
    const reader = createUsageReader();
    expect(reader.read(t.file, "claude")?.tokens).toBe(20);
    writeFileSync(t.file, claudeLine("c", { input_tokens: 1, output_tokens: 1 }));
    expect(reader.read(t.file, "claude")?.tokens).toBe(2);
    expect(reader.read(join(t.file, "missing"), "claude")).toBeNull();
    expect(reader.read(null, "claude")).toBeNull();
  } finally { t.done(); }
});

test("lines that are not usage records are ignored", () => {
  expect(claudeUsage('{"type":"user","message":{"usage":{"input_tokens":5}}}')).toBeNull();
  expect(claudeUsage("not json \"usage\"")).toBeNull();
  expect(codexUsage('{"type":"event_msg","payload":{"type":"token_count","info":null}}')).toBeNull();
});

test("a budget is read from plain numbers and short forms", () => {
  expect(parseBudget("2M")).toBe(2_000_000);
  expect(parseBudget("1.5m tokens")).toBe(1_500_000);
  expect(parseBudget("500k")).toBe(500_000);
  expect(parseBudget("250,000")).toBe(250_000);
  expect(parseBudget(1234.4)).toBe(1234);
  expect(parseBudget("")).toBeNull();
  expect(parseBudget(0)).toBeNull();
  expect(parseBudget(null)).toBeNull();
  for (const bad of ["lots", "-5", "2MM", {}, 1e15, "1e9"]) expect(parseBudget(bad)).toBeUndefined();
});

test("a budget belongs to its launch: set, changed, cleared, and gone with the launch", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyDatabaseSchema(db);
  db.query("INSERT INTO launches (screen, name, project_path, created_at, launch_id) VALUES ('cs-demo', 'demo', '/tmp/demo', 1, 'launch-1')").run();
  db.query("INSERT INTO launches (screen, name, project_path, created_at) VALUES ('cs-old', 'old', '/tmp/old', 1)").run();
  const budgets = createBudgets(db);

  expect(budgets.get("cs-demo")).toBeNull();
  expect(budgets.set("cs-demo", "2M")).toEqual({ ok: true, budget: 2_000_000 });
  expect(budgets.set("cs-demo", 500_000)).toEqual({ ok: true, budget: 500_000 });
  expect([...budgets.all()]).toEqual([["cs-demo", 500_000]]);
  expect(budgets.set("cs-demo", "plenty")).toMatchObject({ ok: false, status: 422 });
  expect(budgets.set("cs-none", "1M")).toMatchObject({ ok: false, status: 404 });
  expect(budgets.set("cs-old", "1M")).toMatchObject({ ok: false, status: 422 });
  expect(budgets.set("cs-demo", "")).toEqual({ ok: true, budget: null });
  expect(budgets.get("cs-demo")).toBeNull();

  budgets.set("cs-demo", "1M");
  db.query("DELETE FROM launches WHERE screen = 'cs-demo'").run();
  expect(db.query("SELECT COUNT(*) AS n FROM session_budgets").get()).toEqual({ n: 0 });
});
