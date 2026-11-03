/** Private stdio adapter. No application/database imports: installed source may be read-only. */
import { runBridge } from "./stdio-bridge";

await runBridge({
  tokenEnv: "CS_COMMUNICATOR_TOKEN", urlEnv: "CS_COMMUNICATOR_URL", path: "/mcp/communicator",
  tokenPattern: /^cscomm_[A-Za-z0-9_-]{43}$/, timeoutMs: 35000,
  messages: {
    unavailable: "Coding Sessions communicator is unavailable outside a configured managed launch.",
    timeout: "Communicator request timed out.",
    failed: "Communicator connection failed. The session may have ended.",
  },
});
