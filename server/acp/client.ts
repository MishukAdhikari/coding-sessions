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

/** The longest prompt, as JSON text, that fits the bridge's 64 KiB command line with room for its envelope. */
export const MAX_PROMPT_JSON_BYTES = 60 * 1024;

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
    let rest: Buffer = Buffer.from(`${JSON.stringify({ id: 1, ...command })}\n`);
    Bun.connect({
      unix: socketPath,
      socket: {
        // A Unix socket takes only what fits its buffer (8 KiB on macOS): send the rest on drain,
        // or a long prompt arrives cut short and the bridge never answers.
        open(socket) { rest = rest.subarray(Math.max(0, socket.write(rest))); },
        drain(socket) { if (rest.length) rest = rest.subarray(Math.max(0, socket.write(rest))); },
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
