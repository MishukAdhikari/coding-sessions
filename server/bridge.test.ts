import { test, expect } from "bun:test";
import { parseBridge } from "./terminal";

// Which ps rows are ttyd bridges this app owns. Everything here is a real line
// shape seen on the box — the screen daemon and the login wrapper repeat the
// whole command string, so only the first token identifies the process.

const REAL = "2236568 /home/example/.local/bin/ttyd --writable -i 127.0.0.1 -p 7702 --base-path /term/119e1d6d -t titleFixed=cs-nstaging -t disableLeaveAlert=true screen -x cs-nstaging";

test("a live bridge parses out pid, port and screen", () => {
  expect(parseBridge(REAL)).toEqual({ pid: 2236568, port: 7702, screen: "cs-nstaging" });
});

test("an attach bridge wrapped for scrollback replay still yields its screen", () => {
  // Attach bridges now run `bash -c "…; exec screen -x 'name'"` so the session's
  // history can be replayed into the terminal before attaching.
  const wrapped = "2236570 /home/example/.local/bin/ttyd --writable -i 127.0.0.1 -p 7703 --base-path /term/ab12cd34 -t scrollback=10000 bash -c h=$(mktemp /tmp/xs-replay.XXXXXX); screen -S 'cs-nstaging' -X hardcopy -h \"$h\"; rm -f \"$h\"; exec screen -x 'cs-nstaging'";
  expect(parseBridge(wrapped)).toEqual({ pid: 2236570, port: 7703, screen: "cs-nstaging" });
});

test("homebrew path on macOS parses too", () => {
  const line = "512 /opt/homebrew/bin/ttyd --writable -i 127.0.0.1 -p 7700 --base-path /term/abc123 screen -x cs-foo";
  expect(parseBridge(line)?.port).toBe(7700);
});

test("THE TRAP: a wrapper repeating the command is not the bridge", () => {
  const wrapper = "999 login -pflq example /home/example/.local/bin/ttyd --writable -p 7702 --base-path /term/119e1d6d screen -x cs-foo";
  expect(parseBridge(wrapper)).toBeNull();
});

test("a ttyd outside our port range is someone else's", () => {
  const other = "777 /usr/bin/ttyd --writable -i 127.0.0.1 -p 8080 --base-path /term/x screen -x cs-foo";
  expect(parseBridge(other)).toBeNull();
});

test("a ttyd without our base-path is someone else's", () => {
  const other = "778 /usr/bin/ttyd --writable -p 7700 bash";
  expect(parseBridge(other)).toBeNull();
});

test("unrelated processes and junk lines are ignored", () => {
  expect(parseBridge("2290892 /home/example/.local/bin/claude --dangerously-skip-permissions")).toBeNull();
  expect(parseBridge("")).toBeNull();
  expect(parseBridge("  PID ARGS")).toBeNull();
});

test("a shell terminal (webterm) is still one of ours", () => {
  const shell = "4242 /home/example/.local/bin/ttyd --writable -i 127.0.0.1 -p 7799 --base-path /term/deadbeef screen -x webterm-deadbeef";
  expect(parseBridge(shell)).toEqual({ pid: 4242, port: 7799, screen: "webterm-deadbeef" });
});

test("a zmx join bridge (zmx path, then the name, at the end) is one of ours", () => {
  const zmx = "5150 /home/example/.local/bin/ttyd --writable -i 127.0.0.1 -p 7704 --base-path /term/0badc0de -t scrollback=10000 sh -c \"$0\" list --short 2>/dev/null | grep -qxF -- \"$1\" || { echo \"This session has ended.\"; exit 1; }; exec env -u ZMX_SESSION \"$0\" attach \"$1\" false /home/example/.local/bin/zmx cs-n-demo";
  expect(parseBridge(zmx)).toEqual({ pid: 5150, port: 7704, screen: "cs-n-demo" });
});

test("the zmx daemon itself is not a bridge", () => {
  expect(parseBridge("5151 /home/example/.local/bin/zmx attach cs-n-demo bash -lc exec claude")).toBeNull();
});

test("private Unix-socket bridges remain recognizable for restart cleanup", () => {
  expect(parseBridge("1234 ttyd --writable -i /run/xs/terminals/t-abcdef/s.sock --base-path /term/1234 screen -x cs-demo")).toEqual({ pid: 1234, port: 0, screen: "cs-demo" });
});
