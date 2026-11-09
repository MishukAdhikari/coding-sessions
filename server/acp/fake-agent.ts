/**
 * A scripted ACP agent for tests (and for trying the chat UI without a real agent).
 * Speaks ACP over stdio. Its behavior is chosen by the prompt text:
 *
 *   "permission"        tool call + permission request (allow once / always / reject)
 *   "always-only"       permission request offering only allow_always and reject_once
 *   "slow"              runs until session/cancel arrives
 *   "showcase"          a long reply with markdown, code, a diff, a failed tool and a plan
 *   "exit"              the agent exits with code 3
 *   anything else       a plan update and a two-chunk reply
 *
 * Env: FAKE_LOAD_SESSION=1 advertises loadSession; FAKE_FAIL_NEW=1 fails session/new;
 * FAKE_REPORT=<path> writes argv, the environment's token and the mcpServers it got.
 */
import { appendFileSync } from "node:fs";
import { createLineFramer, createPeer, rpcError } from "./jsonrpc";

const report = (entry: Record<string, unknown>) => {
  if (process.env.FAKE_REPORT) appendFileSync(process.env.FAKE_REPORT, `${JSON.stringify(entry)}\n`);
};
report({ argv: process.argv, envToken: process.env.CS_COMMUNICATOR_TOKEN ?? null, acpEnvLeft: Object.keys(process.env).filter((k) => k.startsWith("CS_ACP_")) });

let cancelled: (() => void) | null = null;
let cancelRequested = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const peer = createPeer({
  write: (line) => process.stdout.write(`${line}\n`),
  onNotification: (method) => { if (method === "session/cancel") { cancelRequested = true; cancelled?.(); } },
  onRequest: async (method, params) => {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: process.env.FAKE_LOAD_SESSION === "1" },
          agentInfo: { name: "fake-agent", title: "Fake Agent", version: "0.0.1" },
          authMethods: [],
        };
      case "session/new":
      case "session/load": {
        const servers = params?.mcpServers;
        const valid = Array.isArray(servers) && servers.every((s: any) =>
          typeof s?.name === "string" && typeof s.command === "string" && Array.isArray(s.args) &&
          Array.isArray(s.env) && s.env.every((e: any) => typeof e?.name === "string" && typeof e.value === "string"));
        if (!valid) throw rpcError(-32602, "mcpServers must use the ACP stdio form");
        report({ method, mcpServers: servers, cwd: params.cwd, sessionId: params.sessionId ?? null });
        if (method === "session/new" && process.env.FAKE_FAIL_NEW === "1") throw rpcError(-32000, "Authentication required: run fake login");
        if (method === "session/load") {
          await update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier question" } });
          await update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier answer" } });
          return {};
        }
        // Like claude-agent-acp: the command list follows the new session, and may change later.
        if (process.env.FAKE_COMMANDS === "1") setTimeout(() => update("fake-session-1", { sessionUpdate: "available_commands_update", availableCommands: [
          { name: "review", description: "Review the current changes", input: { hint: "what to focus on" } },
          { name: "release", description: "Cut a release", input: null },
          { name: "bad name", description: "never shown" },
        ] }), 10);
        return { sessionId: "fake-session-1" };
      }
      case "session/prompt":
        return prompt(params.sessionId, String(params?.prompt?.[0]?.text ?? ""));
      default:
        throw rpcError(-32601, `Method not found: ${method}`);
    }
  },
});

async function update(sessionId: string, u: Record<string, unknown>) {
  peer.notify("session/update", { sessionId, update: u });
  await sleep(5);
}

async function prompt(sessionId: string, text: string) {
  if (text === "exit") { setTimeout(() => process.exit(3), 20); return { stopReason: "end_turn" }; }
  if (text === "slow") {
    cancelRequested = false;
    await update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it…" } });
    if (!cancelRequested) await new Promise<void>((r) => { cancelled = r; });
    return { stopReason: "cancelled" };
  }
  if (text === "permission" || text === "always-only") {
    await update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit README.md", kind: "edit", status: "pending", locations: [{ path: "/work/README.md" }] });
    const options = text === "permission"
      ? [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ]
      : [
          { optionId: "allow-always", name: "Always allow edits", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ];
    const answer = await peer.request("session/request_permission", { sessionId, toolCall: { toolCallId: "t1", title: "Edit README.md", kind: "edit" }, options });
    report({ permissionAnswer: answer });
    if (answer?.outcome?.outcome !== "selected") return { stopReason: "cancelled" };
    if (String(answer.outcome.optionId).startsWith("reject")) {
      await update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed", content: [{ type: "content", content: { type: "text", text: "Rejected by the user." } }] });
      return { stopReason: "end_turn" };
    }
    await update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "diff", path: "/work/README.md", oldText: "# Old\n", newText: "# New\n" }] });
    await update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: `Done (${answer.outcome.optionId}).` } });
    return { stopReason: "end_turn" };
  }
  if (text === "showcase") return showcase(sessionId);
  await update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Say hello", priority: "high", status: "in_progress" }] });
  await update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hello" } });
  await update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: " world" } });
  await update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Say hello", priority: "high", status: "completed" }] });
  return { stopReason: "end_turn" };
}

async function showcase(sessionId: string) {
  const say = (messageId: string, t: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: t } });
  await update(sessionId, { sessionUpdate: "agent_thought_chunk", messageId: "th1", content: { type: "text", text: "The user wants the retry logic reviewed. I should read the client first, then run the tests." } });
  await update(sessionId, { sessionUpdate: "plan", entries: [
    { content: "Read the HTTP client", priority: "high", status: "completed" },
    { content: "Fix the retry backoff", priority: "high", status: "in_progress" },
    { content: "Run the test suite", priority: "medium", status: "pending" },
  ] });
  await update(sessionId, { sessionUpdate: "tool_call", toolCallId: "s1", title: "Read src/http/client.ts", kind: "read", status: "completed", locations: [{ path: "/work/src/http/client.ts" }], rawInput: { path: "src/http/client.ts" } });
  await say("s-m1", "## What I found\n\nThe retry loop in `client.ts` **doubles the delay** but never caps it, so a flaky upstream can stall a request for minutes.\n\n");
  await say("s-m1", "Three things to change:\n\n1. Cap the delay at `maxDelayMs`.\n2. Add jitter so clients don't retry in lockstep.\n3. Stop retrying on `4xx` responses.\n\n");
  await say("s-m1", "```ts\nconst delay = Math.min(base * 2 ** attempt, maxDelayMs);\nawait sleep(delay / 2 + Math.random() * delay / 2);\n```\n\n| Status | Retry? |\n| --- | --- |\n| 429 | yes |\n| 404 | no |\n| 503 | yes |\n\nSee the [backoff guide](https://example.com/backoff) for details.");
  await update(sessionId, { sessionUpdate: "tool_call", toolCallId: "s2", title: "Edit src/http/client.ts", kind: "edit", status: "completed", content: [{ type: "diff", path: "/work/src/http/client.ts", oldText: "const delay = base * 2 ** attempt;\nawait sleep(delay);\n", newText: "const delay = Math.min(base * 2 ** attempt, maxDelayMs);\nawait sleep(delay / 2 + Math.random() * delay / 2);\n" }] });
  await update(sessionId, { sessionUpdate: "tool_call", toolCallId: "s3", title: "bun test src/http", kind: "execute", status: "failed", rawInput: { command: "bun test src/http" }, content: [{ type: "content", content: { type: "text", text: "error: expect(received).toBe(expected)\n  Expected: 3\n  Received: 4\n(fail) retries > stops on 4xx\n 11 pass\n 1 fail" } }] });
  await say("s-m2", "One test still fails: it expects three attempts on a `404`. I'll update it to expect a single attempt.");
  await update(sessionId, { sessionUpdate: "tool_call", toolCallId: "s4", title: "Edit test/http/client.test.ts", kind: "edit", status: "pending" });
  const answer = await peer.request("session/request_permission", { sessionId, toolCall: { toolCallId: "s4", title: "Edit test/http/client.test.ts", kind: "edit" }, options: [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Always allow edits in this folder", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ] });
  if (answer?.outcome?.outcome !== "selected") return { stopReason: "cancelled" };
  await update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "s4", status: "completed" });
  return { stopReason: "end_turn" };
}

const framer = createLineFramer(16 * 1024 * 1024);
for await (const chunk of Bun.stdin.stream()) for (const line of framer.push(chunk)) peer.handleLine(line);
