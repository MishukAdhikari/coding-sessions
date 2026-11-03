/** Shared stdio ⇄ loopback HTTP adapter for app-owned MCP entries. No application/database imports: installed source may be read-only. */
export interface BridgeOptions {
  tokenEnv: string;
  urlEnv: string;
  path: string;
  tokenPattern: RegExp;
  timeoutMs: number;
  messages: { unavailable: string; timeout: string; failed: string };
  /** Poll a private revision method and emit notifications/tools/list_changed when it changes. */
  revisionMethod?: string;
  revisionIntervalMs?: number;
}

export async function runBridge(options: BridgeOptions): Promise<void> {
  const token = process.env[options.tokenEnv] ?? "";
  let endpoint: URL;
  try {
    endpoint = new URL(process.env[options.urlEnv] ?? "");
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname)
      || endpoint.pathname !== options.path || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !options.tokenPattern.test(token)) throw new Error();
  } catch {
    console.error(options.messages.unavailable);
    process.exit(1);
  }
  const MAX_LINE = 65536;
  // A page includes both structured content and its MCP text representation.
  const MAX_RESPONSE = 32 * 1024 * 1024;
  const active = new Map<string, AbortController>();
  let closed = false;
  const write = (value: unknown) => { if (!closed) process.stdout.write(JSON.stringify(value) + "\n"); };
  const error = (id: unknown, code: number, message: string) => write({ jsonrpc: "2.0", id, error: { code, message } });
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

  async function post(line: string, signal: AbortSignal): Promise<Response> {
    return fetch(endpoint, {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: line,
    });
  }
  async function bounded(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error(); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  async function forward(msg: Record<string, unknown>, line: string): Promise<void> {
    const id = msg.id;
    const key = id === undefined ? null : JSON.stringify(id);
    if (key !== null && active.has(key)) { error(id, -32600, "Duplicate in-flight request ID."); return; }
    if (active.size >= 16) { if (key !== null) error(id, -32000, "Too many simultaneous requests."); return; }
    const abort = new AbortController();
    if (key !== null) active.set(key, abort);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, options.timeoutMs);
    try {
      const response = await post(line, abort.signal);
      if (response.status === 202 && key === null) return;
      if (!response.ok) throw new Error();
      const value = await bounded(response);
      if (!object(value) || value.jsonrpc !== "2.0" || value.id !== id || (!Object.hasOwn(value, "result") && !Object.hasOwn(value, "error"))) throw new Error();
      if (key !== null) write(value);
      if (msg.method === "initialize" && Object.hasOwn(value, "result")) initialized = true;
    } catch {
      if (key !== null) error(id, abort.signal.aborted && !timedOut ? -32800 : -32000,
        abort.signal.aborted && !timedOut ? "Request cancelled." : timedOut ? options.messages.timeout : options.messages.failed);
    } finally {
      clearTimeout(timer);
      if (key !== null) active.delete(key);
    }
  }

  let initialized = false;
  let revision: string | null = null;
  let poller: ReturnType<typeof setInterval> | undefined;
  let polling: AbortController | null = null;
  if (options.revisionMethod) {
    poller = setInterval(async () => {
      if (!initialized || polling || closed) return;
      const abort = polling = new AbortController();
      const timer = setTimeout(() => abort.abort(), 15000);
      try {
        const response = await post(JSON.stringify({ jsonrpc: "2.0", id: "revision", method: options.revisionMethod }), abort.signal);
        if (response.status === 401) { clearInterval(poller); return; }
        if (!response.ok) return;
        const value = await bounded(response);
        const next = object(value) && object(value.result) && typeof value.result.revision === "string" ? value.result.revision : null;
        if (next === null) return;
        // Also on the first value: grants may have changed between the client's tools/list and this poll.
        if (next !== revision) write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        revision = next;
      } catch { /* The next tick retries; the server re-checks grants on every call anyway. */ }
      finally { clearTimeout(timer); if (polling === abort) polling = null; }
    }, options.revisionIntervalMs ?? 10000);
    poller.unref?.();
  }

  function accept(line: string): void {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { error(null, -32700, "Parse error"); return; }
    if (!object(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string"
      || (msg.id !== undefined && msg.id !== null && typeof msg.id !== "string" && typeof msg.id !== "number")) {
      error(null, -32600, "Invalid request"); return;
    }
    if (msg.method === "notifications/cancelled" && msg.id === undefined) {
      if (object(msg.params)) active.get(JSON.stringify(msg.params.requestId))?.abort();
      return;
    }
    // The HTTP service is stateless; notifications need no forwarding or response.
    if (msg.id === undefined) return;
    if (options.revisionMethod && msg.method === options.revisionMethod) { error(msg.id, -32601, "Method not found"); return; }
    void forward(msg, line);
  }

  let buffer = Buffer.alloc(0);
  let dropping = false;
  try {
    for await (const chunk of Bun.stdin.stream()) {
      let remaining = Buffer.from(chunk);
      while (remaining.length) {
        const newline = remaining.indexOf(10);
        const piece = newline < 0 ? remaining : remaining.subarray(0, newline);
        if (!dropping && buffer.length + piece.length > MAX_LINE) {
          dropping = true; buffer = Buffer.alloc(0); error(null, -32600, "Request exceeds 64 KiB.");
        }
        if (!dropping) buffer = Buffer.concat([buffer, piece]);
        if (newline < 0) break;
        if (!dropping && buffer.length) accept(buffer.toString("utf8"));
        buffer = Buffer.alloc(0); dropping = false; remaining = remaining.subarray(newline + 1);
      }
    }
  } finally {
    closed = true;
    if (poller) clearInterval(poller);
    (polling as AbortController | null)?.abort();
    for (const abort of active.values()) abort.abort();
  }
}
