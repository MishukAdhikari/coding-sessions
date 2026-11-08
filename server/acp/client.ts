/**
 * One command to an ACP bridge over its Unix socket: connect, send one NDJSON line,
 * wait for the one-line answer, close. Reads never come through here — the server
 * reads the bridge's event log and state file directly (event-log.ts).
 */
import { createLineFramer } from "./jsonrpc";

export type BridgeCommand =
  | { op: "prompt"; text: string }
  | { op: "cancel" }
  | { op: "permission"; requestId: string; optionId: string }
  | { op: "ping" };

export type BridgeAnswer = { ok: true; [key: string]: unknown } | { ok: false; error: string };

const UNREACHABLE = "The chat bridge isn't answering. The session may have ended.";

export async function sendBridgeCommand(socketPath: string, command: BridgeCommand, timeoutMs = 5000): Promise<BridgeAnswer> {
  return new Promise<BridgeAnswer>((resolve) => {
    let done = false;
    const finish = (answer: BridgeAnswer, socket?: { end(): void }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.end(); } catch {}
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ ok: false, error: UNREACHABLE }), timeoutMs);
    const framer = createLineFramer(1024 * 1024);
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) { socket.write(`${JSON.stringify({ id: 1, ...command })}\n`); },
        data(socket, chunk) {
          for (const line of framer.push(chunk)) {
            try {
              const msg = JSON.parse(line);
              if (msg?.ok === true) return finish({ ...msg, ok: true }, socket);
              return finish({ ok: false, error: typeof msg?.error === "string" ? msg.error : "The chat bridge refused that." }, socket);
            } catch { return finish({ ok: false, error: "The chat bridge sent a bad answer." }, socket); }
          }
        },
        close() { finish({ ok: false, error: UNREACHABLE }); },
        error() { finish({ ok: false, error: UNREACHABLE }); },
        connectError() { finish({ ok: false, error: UNREACHABLE }); },
      },
    }).catch(() => finish({ ok: false, error: UNREACHABLE }));
  });
}
