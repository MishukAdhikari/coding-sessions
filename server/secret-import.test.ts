import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface Entry { name: string; value: string; line?: number; error?: string; suggestion?: string }
interface Parsed { format: "env" | "json"; entries: Entry[]; problems: Array<{ line?: number; reason: string }> }
interface Row { index: number; name: string; length: number; line?: number; status: string; reason?: string; suggestion?: string }
interface Api {
  parse(text: string, format?: string): Parsed;
  annotate(entries: Entry[]): Entry[];
  suggestName(name: string): string | null;
  previewRows(parsed: Parsed, server: Array<{ status: string; reason?: string }>): Row[];
  counts(rows: Row[]): Record<string, number>;
  importBody(parsed: Parsed, rows: Row[], replace: string[]): { entries: Array<{ name: string; value: string }>; replace: string[]; indices: number[] };
}
const context: { window: { SecretImport?: Api } } = { window: {} };
runInNewContext(readFileSync(new URL("../public/secret-import.js", import.meta.url), "utf8"), context);
const SecretImport = context.window.SecretImport!;
const parse = (text: string, format?: string) => SecretImport.parse(text, format);
const values = (parsed: Parsed) => Object.fromEntries(parsed.entries.map(e => [e.name, e.value]));

test(".env: comments, blank lines, export, spaces around = and inline comments", () => {
  const parsed = parse([
    "# a comment",
    "",
    "OPENAI_API_KEY=sk-abc",
    "export GITHUB_TOKEN=ghp_x",
    "  SPACED  =   padded value   ",
    "WITH_COMMENT=value # trailing note",
    "HASH_INSIDE=pa#ss",
    "LEADING_HASH=#literal",
    "EMPTY_COMMENT= # nothing",
    "EQUALS=a=b=c",
  ].join("\n"));
  expect(parsed.format).toBe("env");
  expect(parsed.problems).toEqual([]);
  expect(values(parsed)).toEqual({
    OPENAI_API_KEY: "sk-abc", GITHUB_TOKEN: "ghp_x", SPACED: "padded value", WITH_COMMENT: "value",
    HASH_INSIDE: "pa#ss", LEADING_HASH: "#literal", EMPTY_COMMENT: "", EQUALS: "a=b=c",
  });
  expect(parsed.entries.map(e => e.line)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
});

test(".env: single quotes are literal, double quotes take escapes and may span lines", () => {
  const parsed = parse([
    "SINGLE='literal \\n $HOME # not a comment'",
    'DOUBLE="tab\\there \\"quoted\\" back\\\\slash cr\\r"',
    'PEM="-----BEGIN KEY-----',
    "line two",
    '-----END KEY-----"',
    'AFTER="x" # comment after quote',
    "LAST=1",
  ].join("\n"));
  expect(parsed.problems).toEqual([]);
  expect(values(parsed)).toEqual({
    SINGLE: "literal \\n $HOME # not a comment",
    DOUBLE: 'tab\there "quoted" back\\slash cr\r',
    PEM: "-----BEGIN KEY-----\nline two\n-----END KEY-----",
    AFTER: "x",
    LAST: "1",
  });
  expect(parsed.entries.find(e => e.name === "AFTER")!.line).toBe(6);
  expect(parsed.entries.find(e => e.name === "LAST")!.line).toBe(7);
  expect(values(parse('ESCAPED="line\\nbreak"'))).toEqual({ ESCAPED: "line\nbreak" });
});

test(".env: CRLF line endings and a byte-order mark are read like LF", () => {
  const parsed = parse("﻿A_KEY=one\r\nB_KEY=\"two\r\nlines\"\r\nC_KEY=three\r\n");
  expect(values(parsed)).toEqual({ A_KEY: "one", B_KEY: "two\nlines", C_KEY: "three" });
  expect(parsed.entries.map(e => e.line)).toEqual([1, 2, 4]);
});

test(".env: lines without = and unclosed quotes are problems with their line number, never their text", () => {
  const parsed = parse("GOOD=1\nsk-this-is-a-pasted-value\n=novalue\nOPEN=\"never closed\nNEXT=2\nJUNK='a' b");
  expect(parsed.problems).toEqual([
    { line: 2, reason: "No = on this line." },
    { line: 3, reason: "No name before the =." },
    { line: 4, reason: "OPEN: no closing double quote." },
    { line: 6, reason: "JUNK: text after the closing quote." },
  ]);
  expect(values(parsed)).toEqual({ GOOD: "1", NEXT: "2" });
  expect(JSON.stringify(parsed.problems)).not.toContain("sk-this");
});

test(".env: lowercase or hyphenated names are invalid with a suggested name, never changed silently", () => {
  const parsed = parse("api-key=1\ndb_url=2\n9LIVES=3");
  expect(parsed.entries.map(e => [e.name, e.suggestion ?? null])).toEqual([["api-key", "API_KEY"], ["db_url", "DB_URL"], ["9LIVES", null]]);
  expect(parsed.entries.every(e => e.error)).toBe(true);
  expect(parsed.entries[0]!.error).toContain("API_KEY");
  expect(SecretImport.suggestName("GOOD")).toBeNull();
});

test("duplicates are all marked; the last one does not win", () => {
  const parsed = parse("TWICE=a\nOTHER=b\nTWICE=c");
  expect(parsed.entries.map(e => Boolean(e.error))).toEqual([true, false, true]);
  const json = parse('{"TWICE": "a", "TWICE": "b"}');
  expect(json.entries).toHaveLength(2);
  expect(json.entries.every(e => e.error?.includes("more than once"))).toBe(true);
});

test("JSON: a flat object, with numbers and booleans as text; detected automatically", () => {
  const parsed = parse(' \n{"API_KEY": "sk-1", "PORT": 8080, "BIG": 12345678901234567890, "DEBUG": true, "OFF": false, "ESC": "a\\nb \\u00e9"}');
  expect(parsed.format).toBe("json");
  expect(parsed.problems).toEqual([]);
  expect(values(parsed)).toEqual({ API_KEY: "sk-1", PORT: "8080", BIG: "12345678901234567890", DEBUG: "true", OFF: "false", ESC: "a\nb é" });
  expect(parse("{}").entries).toEqual([]);
});

test("JSON: null, arrays and objects are invalid for that key; bad JSON is one problem that quotes nothing", () => {
  const parsed = parse('{"OK": "v", "NESTED": {"a": "b"}, "LIST": [1, 2], "NOTHING": null}');
  expect(parsed.entries.map(e => [e.name, e.error ?? null])).toEqual([
    ["OK", null], ["NESTED", "Nested values are not supported."], ["LIST", "Nested values are not supported."], ["NOTHING", "null is not a value."],
  ]);
  const broken = parse('{"API_KEY": sk-live-secret}');
  expect(broken.entries).toEqual([]);
  expect(broken.problems).toEqual([{ reason: "This is not valid JSON." }]);
  expect(parse('["A"]', "json").problems[0]!.reason).toMatch(/one JSON object/);
});

test("the format override wins over detection", () => {
  expect(parse("{not json", "env").problems).toEqual([{ line: 1, reason: "No = on this line." }]);
  expect(parse("A_KEY=1", "json").problems).toEqual([{ reason: "This is not valid JSON." }]);
});

test("preview rows: server statuses by index, the parser's reasons first, lengths and never values", () => {
  const parsed = parse("NEW_ONE=alpha-value\nOLD_ONE=beta-value\nSAME_ONE=gamma\napi-key=delta\nRESERVED=x\nno equals here");
  const rows = SecretImport.previewRows(parsed, [
    { status: "new" }, { status: "replace" }, { status: "unchanged" },
    { status: "invalid", reason: "Not a valid name: use capitals, digits and underscores, starting with a letter." },
    { status: "invalid", reason: "Reserved: the server or the session itself uses this name." },
  ]);
  expect(rows.map(r => [r.name, r.status, r.length])).toEqual([
    ["NEW_ONE", "new", 11], ["OLD_ONE", "replace", 10], ["SAME_ONE", "unchanged", 5],
    ["api-key", "invalid", 5], ["RESERVED", "invalid", 1], ["", "invalid", 0],
  ]);
  expect(rows[3]!.suggestion).toBe("API_KEY");
  expect(rows[3]!.reason).toContain("API_KEY");
  expect(rows[4]!.reason).toMatch(/Reserved/);
  expect(rows[5]).toMatchObject({ index: -1, line: 6, reason: "No = on this line." });
  expect(SecretImport.counts(rows)).toEqual({ new: 1, replace: 1, unchanged: 1, invalid: 3 });
  const shown = JSON.stringify(rows);
  for (const value of ["alpha-value", "beta-value", "gamma", "delta"]) expect(shown).not.toContain(value);
});

test("the save body leaves out invalid rows and replaces only ticked names", () => {
  const parsed = parse("NEW_ONE=a\nOLD_ONE=b\nOTHER_OLD=c\nSAME_ONE=d\nbad-name=e");
  const rows = SecretImport.previewRows(parsed, [{ status: "new" }, { status: "replace" }, { status: "replace" }, { status: "unchanged" }, { status: "invalid" }]);
  const body = SecretImport.importBody(parsed, rows, ["OLD_ONE", "SAME_ONE", "bad-name"]);
  expect(body.entries.map(e => e.name)).toEqual(["NEW_ONE", "OLD_ONE", "OTHER_OLD", "SAME_ONE"]);
  expect(body.replace).toEqual(["OLD_ONE"]);
  expect(body.indices).toEqual([0, 1, 2, 3]);
});

test("accepting a suggested name clears its error, and a clash it creates is caught", () => {
  const parsed = parse("api-key=1\nOTHER=2");
  parsed.entries[0]!.name = parsed.entries[0]!.suggestion!;
  SecretImport.annotate(parsed.entries);
  expect(parsed.entries.map(e => e.error ?? null)).toEqual([null, null]);
  const clash = parse("api_key=1\nAPI_KEY=2");
  clash.entries[0]!.name = "API_KEY";
  SecretImport.annotate(clash.entries);
  expect(clash.entries.every(e => e.error?.includes("more than once"))).toBe(true);
  const nested = parse('{"lower": {"a": 1}}');
  nested.entries[0]!.name = "LOWER";
  SecretImport.annotate(nested.entries);
  expect(nested.entries[0]!.error).toBe("Nested values are not supported.");
});
