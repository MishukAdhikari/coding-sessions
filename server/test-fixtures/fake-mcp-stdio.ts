/**
 * A tiny stdio MCP server for tests. argv[2] picks its behaviour:
 *   modern  answers server/discover (2026-07-28); refuses initialize
 *   legacy  answers server/discover with -32601, then initialize as 2025-11-25
 *   silent  never answers server/discover (a legacy server that ignores unknown methods)
 *   huge    prints one 5 MB line in reply to tools/list
 * Every request it receives is appended to argv[3] (a log file) as one JSON line.
 * Tool "env" returns its environment; tool "pid" returns its process id.
 */
import { appendFileSync } from "node:fs";

const mode = process.argv[2] ?? "modern";
const log = process.argv[3];
const send = (message: unknown): void => { process.stdout.write(JSON.stringify(message) + "\n"); };
process.stderr.write("fake server starting; this is a log line, not an error\n");

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(message: any): void {
  if (log) appendFileSync(log, JSON.stringify(message) + "\n");
  if (message.id === undefined) return;
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result });
  const error = (code: number) => send({ jsonrpc: "2.0", id: message.id, error: { code, message: "nope" } });
  switch (message.method) {
    case "server/discover":
      if (mode === "modern" || mode === "huge") {
        return reply({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake-stdio", version: "9.9" } }, instructions: "stdio" });
      }
      if (mode === "legacy") return error(-32601);
      return; // silent
    case "initialize":
      if (mode === "modern") return error(-32601);
      return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake-stdio-legacy", version: "1.0" } });
    case "tools/list":
      if (mode === "huge") { process.stdout.write("x".repeat(5 * 1024 * 1024)); return; }
      return reply({ resultType: "complete", tools: [
        { name: "env", inputSchema: { type: "object" } },
        { name: "pid", inputSchema: { type: "object" } },
      ] });
    case "tools/call":
      if (message.params.name === "env") return reply({ content: [{ type: "text", text: JSON.stringify(process.env) }] });
      if (message.params.name === "pid") return reply({ content: [{ type: "text", text: String(process.pid) }] });
      return error(-32602);
    default:
      return error(-32601);
  }
}
