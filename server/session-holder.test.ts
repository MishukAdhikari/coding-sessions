import { expect, test } from "bun:test";
import { findProviderProcess, holderScreenFor, type Proc } from "./sessions";

// One herdr server (100) owns every pane. Pane cs-a runs `bash -lc` (201) with claude (301)
// under it; pane cs-b's bash exec'd codex, so the pane's root process is codex itself (202).
const procs: Proc[] = [
  { pid: 1, ppid: 0, etimes: 9000, pcpu: 0, args: "/sbin/init" },
  { pid: 100, ppid: 1, etimes: 900, pcpu: 0.1, args: "herdr --session coding-sessions server" },
  { pid: 201, ppid: 100, etimes: 600, pcpu: 0, args: "bash -lc exec claude --remote-control demo" },
  { pid: 301, ppid: 201, etimes: 599, pcpu: 2, args: "claude --remote-control demo" },
  { pid: 202, ppid: 100, etimes: 500, pcpu: 1, args: "codex --no-alt-screen" },
  { pid: 400, ppid: 1, etimes: 50, pcpu: 0, args: "claude" },
];
const byPid = new Map(procs.map((p) => [p.pid, p]));
const proc = (pid: number) => byPid.get(pid)!;

test("under herdr, each agent maps to its own pane, keyed by the pane's root pid", () => {
  // What mux.listAll reports for herdr: pid = pane.process_info's shell_pid.
  const screens = new Map([[201, "cs-a"], [202, "cs-b"]]);
  expect(holderScreenFor(proc(301), screens, byPid)).toBe("cs-a");
  expect(holderScreenFor(proc(202), screens, byPid)).toBe("cs-b");
  expect(holderScreenFor(proc(400), screens, byPid)).toBeNull();
  expect(findProviderProcess(procs, 202, "codex")?.pid).toBe(202);
  expect(findProviderProcess(procs, 201, "claude")?.pid).toBe(301);
});

test("keying holders by the shared herdr server would merge every agent into one session", () => {
  // Why the pane's own pid is used: the server pid can hold only one name.
  const screens = new Map([[100, "cs-a"], [100, "cs-b"]]);
  expect(holderScreenFor(proc(301), screens, byPid)).toBe("cs-b");
  expect(holderScreenFor(proc(202), screens, byPid)).toBe("cs-b");
});
