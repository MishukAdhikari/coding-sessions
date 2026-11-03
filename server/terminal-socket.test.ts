import { test, expect } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createTerminalSocket, secureTerminalSocket } from "./terminal-socket";

test("private terminal sockets carry HTTP and WebSocket traffic without TCP", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "xt-"));
  const socket = createTerminalSocket(root);
  const server = Bun.serve({ unix: socket.socketPath,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response("fixture-http"); },
    websocket: { message(ws, value) { ws.send(value); } },
  });
  try {
    expect(statSync(dirname(socket.socketPath)).mode & 0o777).toBe(0o700);
    expect(secureTerminalSocket(socket.socketPath)).toBe(true);
    expect(statSync(socket.socketPath).mode & 0o777).toBe(0o600);
    expect(await (await fetch("http://localhost/fixture", { unix: socket.socketPath })).text()).toBe("fixture-http");
    const result = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws+unix://${socket.socketPath}:/fixture`);
      const timeout = setTimeout(() => { ws.close(); reject(Error("Unix WebSocket timeout")); }, 2000);
      ws.onopen = () => ws.send("fixture-ws");
      ws.onmessage = event => { clearTimeout(timeout); ws.close(); resolve(event.data); };
      ws.onerror = () => { clearTimeout(timeout); reject(Error("Unix WebSocket failed")); };
    });
    expect(result).toBe("fixture-ws");
  } finally { server.stop(true); socket.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test("terminal runtime rejects symlinks without creating files through them", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "xt-"));
  try {
    mkdirSync(join(root, "actual")); symlinkSync(join(root, "actual"), join(root, "link"));
    expect(() => createTerminalSocket(join(root, "link"))).toThrow();
    expect(secureTerminalSocket(join(root, "actual"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
