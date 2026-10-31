import { expect, test } from "bun:test";
import { attachArgv, newSessionBackend, parseScreenLs, parseZmxList, spawnArgv } from "./mux";

test("zmx list rows parse to name + the pid of the command it runs", () => {
  // Captured from zmx 0.8.1 on the deploy host.
  const out =
    "  name=cs-n-demo\tpid=3472618\tclients=0\tcreated=1790686450\tcwd=file://xcloud-agent-eu-ccx13/tmp\tcmd=bash -lc 'exec claude'\n" +
    "  name=webterm-ab12cd34\tpid=3472633\tclients=1\tcreated=1790686451\tcwd=file://xcloud-agent-eu-ccx13/home/example\tcmd=bash -lc 'exec bash -l'\n";
  expect(parseZmxList(out)).toEqual([
    { name: "cs-n-demo", pid: 3472618, backend: "zmx" },
    { name: "webterm-ab12cd34", pid: 3472633, backend: "zmx" },
  ]);
});

test("an unreachable (busy) zmx daemon is still live, pid unknown; a refused one is gone", () => {
  const out =
    "  name=cs-busy\terr=Timeout\tstatus=unreachable\n" +
    "  name=cs-dead\terr=ConnectionRefused\tstatus=cleaning up\n" +
    "→ name=cs-current\tpid=77\tclients=1\tcreated=1\n";
  expect(parseZmxList(out)).toEqual([
    { name: "cs-busy", pid: null, backend: "zmx" },
    { name: "cs-current", pid: 77, backend: "zmx" },
  ]);
});

test("zmx's empty listing and junk parse to nothing", () => {
  expect(parseZmxList("no sessions found in /home/example/.zmx\n")).toEqual([]);
  expect(parseZmxList("")).toEqual([]);
});

test("screen -ls rows parse to name + daemon pid", () => {
  const out = "There are screens on:\n\t2893514.cs-n-hotfix-express\t(09/27/2026 03:11:48 AM)\t(Detached)\n\t436823.webterm-x\t(09/01/2026)\t(Attached)\n2 Sockets in /run/screen/S-example.\n";
  expect(parseScreenLs(out)).toEqual([
    { name: "cs-n-hotfix-express", pid: 2893514, backend: "screen" },
    { name: "webterm-x", pid: 436823, backend: "screen" },
  ]);
});

test("detached launch argv per holder", () => {
  expect(spawnArgv("zmx", "cs-a", "exec claude", "/z/zmx")).toEqual(["/z/zmx", "attach", "cs-a", "bash", "-lc", "exec claude"]);
  expect(spawnArgv("screen", "cs-a", "exec claude")).toEqual(["screen", "-dmS", "cs-a", "bash", "-lc", "exec claude"]);
});

test("attach argv per holder; zmx joins only a listed session and never inherits ZMX_SESSION", () => {
  const zmx = attachArgv({ name: "cs-a", backend: "zmx" }, "/z/zmx");
  expect(zmx.slice(0, 2)).toEqual(["sh", "-c"]);
  expect(zmx.slice(-2)).toEqual(["/z/zmx", "cs-a"]);
  expect(zmx[2]).toContain('env -u ZMX_SESSION "$0" attach "$1" false');
  expect(attachArgv({ name: "cs-a", backend: "screen" })).toEqual(["screen", "-x", "cs-a"]);
});

test("CS_MUX=screen forces the legacy holder for new sessions", () => {
  const prev = process.env.CS_MUX;
  process.env.CS_MUX = "screen";
  try { expect(newSessionBackend()).toBe("screen"); }
  finally { if (prev === undefined) delete process.env.CS_MUX; else process.env.CS_MUX = prev; }
});
