import { test, expect } from "bun:test";
import { parseEtime, parsePsLine } from "./sessions";

// Linux `ps -eo etimes` gives elapsed seconds outright; macOS (BSD) `ps -axo etime`
// only has [[dd-]hh:]mm:ss. Both must land on the same Proc shape.

test("etime mm:ss", () => {
  expect(parseEtime("07:12")).toBe(432);
});

test("etime hh:mm:ss", () => {
  expect(parseEtime("02:03:04")).toBe(7384);
});

test("etime with days", () => {
  expect(parseEtime("3-04:05:06")).toBe(3 * 86400 + 4 * 3600 + 5 * 60 + 6);
});

test("etime garbage → null", () => {
  expect(parseEtime("-")).toBeNull();
  expect(parseEtime("")).toBeNull();
});

test("linux line: bare-seconds etimes column", () => {
  expect(parsePsLine("  1234  1200  86400  0.4 claude --remote-control foo")).toEqual({
    pid: 1234, ppid: 1200, etimes: 86400, pcpu: 0.4,
    args: "claude --remote-control foo",
  });
});

test("macos line: etime column converts to seconds", () => {
  expect(parsePsLine(" 1234 1200 24:00:00 0.4 claude --remote-control foo")).toEqual({
    pid: 1234, ppid: 1200, etimes: 86400, pcpu: 0.4,
    args: "claude --remote-control foo",
  });
});

test("args keep their spacing and flags", () => {
  const p = parsePsLine(" 42 1 05:00 12.5 /Users/example/.local/bin/claude --remote-control my-sess --dangerously-skip-permissions");
  expect(p?.args).toBe("/Users/example/.local/bin/claude --remote-control my-sess --dangerously-skip-permissions");
  expect(p?.etimes).toBe(300);
});

test("header or malformed line → null", () => {
  expect(parsePsLine("  PID  PPID ELAPSED %CPU COMMAND")).toBeNull();
  expect(parsePsLine("")).toBeNull();
});
