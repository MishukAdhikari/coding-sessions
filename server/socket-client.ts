#!/usr/bin/env bun
/**
 * A client for the local control socket (server/control-socket.ts): one request, one
 * answer. `cs socket` uses it, and on an installed server it runs with the app's own Bun:
 *
 *   sudo -u cs-<instance> /opt/coding-sessions/<instance>/current/bin/bun \
 *     /opt/coding-sessions/<instance>/current/server/socket-client.ts list_sessions
 *
 * Params come from the second argument, or from stdin when it is "-", so a prompt or a
 * one-time code never has to appear in the process list. It imports nothing else from the
 * server, so the CLI can use it on its own.
 */
import { join } from "node:path";

type Environment = Record<string, string | undefined>;
export type SocketAnswer = { id: unknown; result?: unknown; error?: { code: string; message: string } };

/** The socket a client should use when none is named: CS_SOCKET_PATH, else CS_DATA_DIR/cs.sock. */
export function defaultSocketPath(env: Environment): string | null {
  if (env.CS_SOCKET_PATH) return env.CS_SOCKET_PATH;
  return env.CS_DATA_DIR ? join(env.CS_DATA_DIR, "cs.sock") : null;
}

/** `[--socket=<path>] <method> [params-json | -]` */
export function parseClientArgs(argv: string[], env: Environment) {
  let path: string | null = null;
  const rest: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--socket=")) path = arg.slice(9);
    else rest.push(arg);
  }
  path ??= defaultSocketPath(env);
  const [method, params] = rest;
  if (!method) throw new Error("name a method, such as ping, methods or list_sessions.");
  if (!path) throw new Error("no control socket: pass --socket=<path> or set CS_SOCKET_PATH.");
  return { path, method, params };
}

/** Send one request and wait for the answer with its id. The connection stays open until then. */
export function socketRequest(path: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 100_000): Promise<SocketAnswer> {
  const id = `cs-${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.end(); } catch {}
      fn();
    };
    // wait_for_session waits up to 90 s, so the default leaves room for it.
    const timer = setTimeout(() => finish(() => reject(new Error(`no answer from ${path} within ${Math.round(timeoutMs / 1000)} s.`))), timeoutMs);
    Bun.connect({
      unix: path,
      socket: {
        data(_s, chunk) {
          buffer += Buffer.from(chunk).toString("utf8");
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            let answer: SocketAnswer;
            try { answer = JSON.parse(line); } catch { continue; }
            // An answer for this request, or the server turning the connection away.
            if (answer.id === id || (answer.id === null && answer.error)) return finish(() => resolve(answer));
          }
        },
        close() { finish(() => reject(new Error(`${path} closed the connection without answering.`))); },
        error(_s, e) { finish(() => reject(e)); },
      },
    }).then((s) => {
      socket = s;
      if (settled) { s.end(); return; }
      s.write(JSON.stringify({ id, method, params }) + "\n");
    }, (e: NodeJS.ErrnoException) => {
      const hint = e?.code === "ENOENT" || e?.code === "ECONNREFUSED"
        ? `no control socket at ${path}. Is the server running with CS_SOCKET=1 (or CS_SOCKET_PATH)?`
        : `can't connect to ${path}: ${e?.message ?? e}`;
      finish(() => reject(new Error(hint)));
    });
  });
}

/** Run one request from argv; returns the process exit code. */
export async function runClient(argv: string[], env: Environment = process.env, stdin: () => Promise<string> = () => Bun.stdin.text()): Promise<number> {
  const { path, method, params } = parseClientArgs(argv, env);
  const text = params === "-" ? await stdin() : params;
  let parsed: unknown = {};
  if (text?.trim()) {
    try { parsed = JSON.parse(text); } catch { throw new Error("params must be a JSON object."); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("params must be a JSON object.");
  const answer = await socketRequest(path, method, parsed as Record<string, unknown>);
  if (answer.error) {
    console.error(`${answer.error.code}: ${answer.error.message}`);
    return 1;
  }
  console.log(JSON.stringify(answer.result, null, 2));
  return 0;
}

if (import.meta.main) {
  try { process.exit(await runClient(process.argv.slice(2))); } catch (e) {
    console.error(`socket-client: ${(e as Error).message}`);
    process.exit(2);
  }
}
