/**
 * The local control socket (CS_SOCKET / CS_SOCKET_PATH): the MCP tools over a Unix
 * socket, for scripts and agents on this machine that should not need HTTP, OAuth or a
 * token. The filesystem is the authentication: the socket is 0600 in a 0700 directory, so
 * only the service account and root can connect. It never listens on TCP.
 *
 * Protocol: newline-delimited JSON. Each line is {"id","method","params"}; each answer is
 * one line, {"id","result"} or {"id","error":{"code","message"}}, matched by id (requests
 * on one connection may finish out of order). Methods are "ping", "methods" and every MCP
 * tool by its MCP name, run by the same handler /mcp uses.
 */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { callTool, TOOLS, type McpDeps } from "./mcp";

export type SocketErrorCode = "parse_error" | "invalid_request" | "unknown_method" | "tool_error" | "too_large" | "busy" | "internal";
export interface SocketRequest { id: unknown; method: string; params: Record<string, unknown> }
export type SocketReply =
  | { id: unknown; result: unknown }
  | { id: unknown; error: { code: SocketErrorCode; message: string } };

export interface SocketLimits {
  maxLineBytes: number;  // one request line, like the HTTP listener's body limit
  perConnection: number; // requests in flight on one connection
  total: number;         // requests in flight on the whole socket
  connections: number;   // open connections
}
export const DEFAULT_LIMITS: SocketLimits = { maxLineBytes: 1024 * 1024, perConnection: 8, total: 64, connections: 32 };

const fail = (id: unknown, code: SocketErrorCode, message: string): SocketReply => ({ id, error: { code, message } });
const TOOL_NAMES = new Set<string>(TOOLS.map((t) => t.name));

/* ---------- protocol ---------- */

export function parseRequest(line: string): { ok: true; request: SocketRequest } | { ok: false; reply: SocketReply } {
  let msg: unknown;
  try { msg = JSON.parse(line); } catch { return { ok: false, reply: fail(null, "parse_error", "Each line must be one JSON object.") }; }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return { ok: false, reply: fail(null, "invalid_request", "A request is a JSON object with id, method and params.") };
  }
  const { id = null, method, params = {} } = msg as Record<string, unknown>;
  if (typeof method !== "string") return { ok: false, reply: fail(id, "invalid_request", "method must be a string.") };
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, reply: fail(id, "invalid_request", "params must be an object.") };
  }
  return { ok: true, request: { id, method, params: params as Record<string, unknown> } };
}

/** What "methods" returns: the two socket methods, then every MCP tool with its schema. */
export function socketMethods() {
  return [
    { name: "ping", title: "Ping", description: "Check the server answers.", params: { type: "object", properties: {} } },
    { name: "methods", title: "List methods", description: "Every method this socket takes, with its params.", params: { type: "object", properties: {} } },
    ...TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, params: t.inputSchema })),
  ];
}

export async function handleRequest(deps: McpDeps, request: SocketRequest): Promise<SocketReply> {
  const { id, method, params } = request;
  if (method === "ping") return { id, result: { pong: true } };
  if (method === "methods") return { id, result: { methods: socketMethods() } };
  if (!TOOL_NAMES.has(method)) return fail(id, "unknown_method", `Unknown method ${JSON.stringify(method)}. "methods" lists them.`);
  try {
    const out = await callTool(deps, method, params);
    if (out.isError) return fail(id, "tool_error", out.content.map((c) => c.text).join("\n"));
    return { id, result: out.structuredContent ?? {} };
  } catch (e) {
    return fail(id, "internal", (e as Error)?.message ?? String(e));
  }
}

/** Splits a byte stream into lines; returns null once a line is longer than the limit. */
export function createLineSplitter(maxLineBytes: number) {
  let pending: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Uint8Array): string[] | null {
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      const lines: string[] = [];
      let nl: number;
      while ((nl = pending.indexOf(10)) >= 0) {
        if (nl > maxLineBytes) return null;
        const line = pending.subarray(0, nl).toString("utf8").replace(/\r$/, "");
        pending = pending.subarray(nl + 1);
        if (line.trim()) lines.push(line);
      }
      return pending.length > maxLineBytes ? null : lines;
    },
  };
}

/* ---------- the socket file ---------- */

/**
 * Make the socket's directory private (created 0700, or checked: ours and closed to group
 * and others) and clear the way for the socket: an old socket file is removed, anything
 * else at the path is refused. One data directory belongs to one server.
 */
export function prepareSocketPath(path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const d = lstatSync(dir);
  if (!d.isDirectory()) throw new Error(`The control socket's folder ${dir} is not a directory.`);
  if (typeof process.getuid === "function" && d.uid !== process.getuid()) {
    throw new Error(`The control socket's folder ${dir} must belong to the account running Coding Sessions.`);
  }
  if (d.mode & 0o077) throw new Error(`The control socket's folder ${dir} must be private (chmod 0700): other accounts can reach it.`);
  let existing;
  try { existing = lstatSync(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (!existing.isSocket()) throw new Error(`${path} exists and is not a socket; move it away or choose another CS_SOCKET_PATH.`);
  unlinkSync(path);
}

/* ---------- the listener ---------- */

interface Connection {
  splitter: ReturnType<typeof createLineSplitter>;
  inFlight: number;
  out: Buffer;      // answers the kernel has not taken yet
  closing: boolean; // close once out is written
  peerDone: boolean; // the client closed its end; close once its answers are out
  closed: boolean;
}

export function startControlSocket(opts: {
  path: string;
  deps: McpDeps;
  log?: (line: string) => void;
  limits?: Partial<SocketLimits>;
}) {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const log = opts.log ?? ((line: string) => console.log(line));
  const connections = new Map<Bun.Socket<undefined>, Connection>();
  let inFlight = 0;

  prepareSocketPath(opts.path);

  const flush = (socket: Bun.Socket<undefined>, c: Connection) => {
    if (c.closed) return;
    if (c.out.length) {
      const wrote = socket.write(c.out);
      c.out = wrote > 0 ? c.out.subarray(wrote) : c.out;
    }
    if (!c.out.length && (c.closing || (c.peerDone && c.inFlight === 0))) socket.end();
  };
  const send = (socket: Bun.Socket<undefined>, c: Connection, reply: SocketReply) => {
    if (c.closed) return;
    const line = Buffer.from(JSON.stringify(reply) + "\n");
    c.out = c.out.length ? Buffer.concat([c.out, line]) : line;
    flush(socket, c);
  };

  async function run(socket: Bun.Socket<undefined>, c: Connection, request: SocketRequest) {
    const started = Date.now();
    const reply = await handleRequest(opts.deps, request);
    c.inFlight--;
    inFlight--;
    // Method and outcome only: params and results can hold prompts, screens and codes.
    const method = request.method === "ping" || request.method === "methods" || TOOL_NAMES.has(request.method) ? request.method : "(unknown)";
    log(`control socket: ${method} ${"error" in reply ? reply.error.code : "ok"} ${Date.now() - started}ms`);
    send(socket, c, reply);
  }

  // Bun creates the socket file with the process umask; keep it closed to everyone else
  // from the first moment, then make the mode explicit.
  const umask = process.umask(0o177);
  let listener: Bun.UnixSocketListener<undefined>;
  try {
    listener = Bun.listen({
      unix: opts.path,
      // `nc -U` and `socat` close their end when their input ends, then read the answers.
      // Bun 1.3 still drops the connection at that point (1.4.4 does not), so clients
      // should stay connected until their answers arrive (docs/socket.md).
      allowHalfOpen: true,
      socket: {
        open(socket) {
          const c: Connection = { splitter: createLineSplitter(limits.maxLineBytes), inFlight: 0, out: Buffer.alloc(0), closing: false, peerDone: false, closed: false };
          connections.set(socket, c);
          if (connections.size > limits.connections) {
            c.closing = true;
            send(socket, c, fail(null, "busy", "Too many open connections."));
          }
        },
        data(socket, chunk) {
          const c = connections.get(socket);
          if (!c || c.closing) return;
          const lines = c.splitter.push(chunk);
          if (!lines) {
            // The line's end is unknown, so nothing after it can be framed: answer and close.
            c.closing = true;
            send(socket, c, fail(null, "too_large", `A request line is limited to ${limits.maxLineBytes} bytes.`));
            return;
          }
          for (const line of lines) {
            const parsed = parseRequest(line);
            if (!parsed.ok) { send(socket, c, parsed.reply); continue; }
            if (c.inFlight >= limits.perConnection || inFlight >= limits.total) {
              send(socket, c, fail(parsed.request.id, "busy", "Too many requests in flight; wait for an answer and retry."));
              continue;
            }
            c.inFlight++;
            inFlight++;
            void run(socket, c, parsed.request);
          }
        },
        end(socket) {
          const c = connections.get(socket);
          if (!c) return;
          c.peerDone = true;
          flush(socket, c);
        },
        drain(socket) {
          const c = connections.get(socket);
          if (c) flush(socket, c);
        },
        close(socket) {
          const c = connections.get(socket);
          if (c) c.closed = true;
          connections.delete(socket);
        },
        error(socket) {
          const c = connections.get(socket);
          if (c) c.closed = true;
          connections.delete(socket);
        },
      },
    });
  } finally {
    process.umask(umask);
  }
  chmodSync(opts.path, 0o600);
  const s = lstatSync(opts.path);
  if (!s.isSocket() || (s.mode & 0o777) !== 0o600) {
    listener.stop(true);
    throw new Error(`Could not make the control socket ${opts.path} private.`);
  }

  return {
    path: opts.path,
    stop() {
      listener.stop(true);
      try { unlinkSync(opts.path); } catch {}
    },
  };
}
