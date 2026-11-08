/**
 * JSON-RPC 2.0 over newline-delimited JSON, as the Agent Client Protocol's stdio
 * transport frames it: one message per line, no embedded newlines.
 *
 * Small on purpose: the ACP bridge (bridge.ts) is the only peer, and it runs inside
 * the session's mux holder, so it must not pull in the server's modules.
 */

export type JsonRpcId = string | number;

export interface JsonRpcError { code: number; message: string; data?: unknown }

/** Split a byte stream into lines. A line longer than `maxLineBytes` is dropped and reported, never buffered forever. */
export function createLineFramer(maxLineBytes: number, onOversize: (bytes: number) => void = () => {}) {
  let pending = Buffer.alloc(0);
  let skipping = false; // inside an oversized line: discard until its newline
  return {
    push(chunk: Uint8Array): string[] {
      pending = pending.length ? Buffer.concat([pending, Buffer.from(chunk)]) : Buffer.from(chunk);
      const lines: string[] = [];
      let nl: number;
      while ((nl = pending.indexOf(10)) >= 0) {
        const raw = pending.subarray(0, nl);
        pending = pending.subarray(nl + 1);
        if (skipping) { skipping = false; continue; }
        if (raw.length > maxLineBytes) { onOversize(raw.length); continue; }
        const line = raw.toString("utf8").replace(/\r$/, "");
        if (line.trim()) lines.push(line);
      }
      if (pending.length > maxLineBytes) {
        onOversize(pending.length);
        pending = Buffer.alloc(0);
        skipping = true;
      }
      return lines;
    },
  };
}

interface Pending { resolve: (value: any) => void; reject: (error: Error & { rpc?: JsonRpcError }) => void; timer: ReturnType<typeof setTimeout> | null }

export interface PeerHandlers {
  /** Send one serialized message (no trailing newline needed). */
  write: (line: string) => void;
  /** A request from the other side. Return a result, or throw `rpcError(...)`. */
  onRequest?: (method: string, params: any, id: JsonRpcId) => unknown | Promise<unknown>;
  onNotification?: (method: string, params: any) => void;
}

/** An error that becomes a JSON-RPC error response. */
export function rpcError(code: number, message: string, data?: unknown): Error & { rpc: JsonRpcError } {
  return Object.assign(new Error(message), { rpc: { code, message, ...(data === undefined ? {} : { data }) } });
}

export function createPeer(handlers: PeerHandlers) {
  let nextId = 0;
  const pending = new Map<JsonRpcId, Pending>();
  const send = (message: object) => handlers.write(JSON.stringify(message));

  function request<T = any>(method: string, params?: unknown, timeoutMs = 0): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs)
        : null;
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  function notify(method: string, params?: unknown): void {
    send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  async function answer(id: JsonRpcId, method: string, params: unknown) {
    if (!handlers.onRequest) return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    try {
      const result = await handlers.onRequest(method, params, id);
      send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (e) {
      const rpc = (e as { rpc?: JsonRpcError }).rpc ?? { code: -32603, message: (e as Error)?.message || "Internal error" };
      send({ jsonrpc: "2.0", id, error: rpc });
    }
  }

  /** Feed one received line. Malformed input is ignored: the agent's stdout is not ours to crash on. */
  function handleLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;
    const hasId = typeof msg.id === "string" || typeof msg.id === "number";
    if (typeof msg.method === "string") {
      if (hasId) void answer(msg.id, msg.method, msg.params);
      else handlers.onNotification?.(msg.method, msg.params);
      return;
    }
    if (!hasId) return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (msg.error && typeof msg.error === "object") {
      const err = Object.assign(new Error(String(msg.error.message ?? "Request failed")), { rpc: msg.error as JsonRpcError });
      waiter.reject(err);
    } else waiter.resolve(msg.result);
  }

  /** Fail every request still waiting, e.g. when the agent exits. */
  function close(reason: string): void {
    for (const [id, waiter] of pending) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
      pending.delete(id);
    }
  }

  return { request, notify, handleLine, close, get pendingCount() { return pending.size; } };
}

export type Peer = ReturnType<typeof createPeer>;
