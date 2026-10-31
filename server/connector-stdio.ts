/** Private stdio adapter for granted external connectors. No application/database imports. */
import { runBridge } from "./stdio-bridge";

await runBridge({
  tokenEnv: "CS_CONNECTOR_TOKEN", urlEnv: "CS_CONNECTOR_URL", path: "/mcp/connectors",
  tokenPattern: /^csconn_[A-Za-z0-9_-]{43}$/, timeoutMs: 130000,
  revisionMethod: "coding_sessions/tools_revision", revisionIntervalMs: Number(process.env.CS_CONNECTOR_REVISION_MS) || 10000,
  messages: {
    unavailable: "Coding Sessions connectors are unavailable outside a configured managed launch.",
    timeout: "Connector request timed out.",
    failed: "Connector connection failed. The session may have ended or lost access.",
  },
});
