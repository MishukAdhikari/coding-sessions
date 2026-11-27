import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface Entry { name: string; value: string; line?: number; error?: string; suggestion?: string }
interface Parsed { format: "env" | "json"; entries: Entry[]; problems: Array<{ line?: number; reason: string }> }
const context: { window: { SecretImport?: { parse(text: string, format?: string): Parsed; suggestName(name: string): string | null } } } = { window: {} };
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
