/** Private stdio adapter. No application/database imports: installed source may be read-only. */
const token = process.env.CS_COMMUNICATOR_TOKEN ?? "";
let endpoint: URL;
try {
  endpoint = new URL(process.env.CS_COMMUNICATOR_URL ?? "");
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname)
    || endpoint.pathname !== "/mcp/communicator" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !/^cscomm_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
} catch {
  console.error("Coding Sessions communicator is unavailable outside a configured managed launch.");
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

async function forward(msg: Record<string, unknown>, line: string): Promise<void> {
  const id = msg.id;
  const key = id === undefined ? null : JSON.stringify(id);
  if (key !== null && active.has(key)) { error(id, -32600, "Duplicate in-flight request ID."); return; }
  if (active.size >= 16) { if (key !== null) error(id, -32000, "Too many simultaneous requests."); return; }
  const abort = new AbortController();
  if (key !== null) active.set(key, abort);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, 35000);
  try {
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", signal: abort.signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: line,
    });
    if (response.status === 202 && key === null) return;
    if (!response.ok) throw new Error();
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
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!object(value) || value.jsonrpc !== "2.0" || value.id !== id || (!Object.hasOwn(value, "result") && !Object.hasOwn(value, "error"))) throw new Error();
    if (key !== null) write(value);
  } catch {
    if (key !== null) error(id, abort.signal.aborted && !timedOut ? -32800 : -32000,
      abort.signal.aborted && !timedOut ? "Request cancelled." : timedOut ? "Communicator request timed out." : "Communicator connection failed. The session may have ended.");
  } finally {
    clearTimeout(timer);
    if (key !== null) active.delete(key);
  }
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
  for (const abort of active.values()) abort.abort();
}
