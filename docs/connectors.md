# External MCP connectors

Coding Sessions can hold one credential for another service's MCP server and let the agents it launches use selected tools from it. Codex, Claude Code, and Command Code sessions then share one managed connection instead of each signing in separately.

This is the reverse of [the MCP connector](mcp.md): that page covers apps connecting **to** Coding Sessions. This page covers Coding Sessions connecting **out** to another service. The two use separate credentials, data, and Settings screens.

## What this release does

- **One preset: the xcdev lab** at `https://xcdev.tmp1.dev/mcp`. Arbitrary URLs and local (stdio) servers cannot be added.
- **Read-only.** Only a curated list of xcdev tools can be granted: `qa_guide`, `lab_list`, `env_status`, `qa_preflight`, `jobs_list`, `job_wait`, `task_log`, `archives_list`, `fixture_list`, `wl_status`, `server_health`. Everything else the service offers is shown but cannot be granted. Write tools wait for per-resource ownership, so two agents cannot silently change the same lab environment through this path.
- **Token sign-in only.** Paste a token made in xcdev's own settings. A dedicated agent token is recommended over a personal one. Browser (OAuth) sign-in is not available yet: it needs this server's callback allowed by xcdev.

## Set it up

1. **Settings › Connections & access › External MCP connectors › Add xcdev lab.** Adding it grants nothing.
2. **Paste the token** and save. It is tested immediately. The screen shows **Connected** only after a real discovery against the service succeeds, and the account only when the service reports it.
3. **Choose tools.** Tick tools individually or use the recommended read-only set. Tools the service adds later stay off.
4. **Choose who gets access.**
   - *New sessions get access*: per agent (Claude, Codex, Command Code). Off by default.
   - *Running sessions*: per session. Only sessions started while a connector was enabled are listed; older sessions get the connector entry when you resume them.

Agents see the tools as `xcdev__<tool>` on an MCP server named `coding_sessions_connectors`, plus `list_connections`, which reports what that session may use and the account it acts as.

## Changes and revocation

Every call is checked against the current settings: the session must be running, the connector enabled, the session granted, and the tool granted and still offered by the service. Disabling, disconnecting, replacing the token, or removing a grant takes effect on the next call and cancels calls already running; their results are discarded even if access is restored before they finish.

The agent's tool list updates within about 10 seconds for agents that support MCP tool-list updates; others show the change after the session is resumed. A tool that is still listed but no longer granted is refused.

**Disconnect** deletes the token and every grant on this server immediately. It does not revoke the token at xcdev; do that in xcdev too if the token should stop working everywhere.

## Status meanings

| Status | Meaning |
|---|---|
| Needs token | No token saved. |
| Not checked | A token is saved but has not been tested since it changed. |
| Connected | The last test reached the service with this token. |
| Needs sign-in | The service rejected the token. |
| No permission | The token works but its account may not do this. |
| Unavailable | The service could not be reached or answered unexpectedly; the token was not judged. |
| Disabled | No session can use the connector. |

## Collaboration skill

Managed launches install an app-owned skill, `coding-sessions-collaboration`, into `~/.claude/skills` and `~/.agents/skills`. It explains the difference between messaging (the communicator) and access (connectors), that a message never grants access, and the one-writer-per-shared-resource rule. For lab workflows it points agents to xcdev's own `qa_guide`. A folder of the same name without the app's `.coding-sessions-owned` marker is left alone.

## Requirements and limits

- The server must have its token-encryption key (`LoadCredential=token-encryption-key` or `CS_TOKEN_KEY_FILE`). Without it, saving a connector token is refused; there is no plaintext fallback.
- `CS_CONNECTOR_XCDEV_URL` may point the preset at another deployment. It must be HTTPS, or HTTP on loopback for local testing. Redirects are never followed and no URL is taken from the service's metadata.
- Upstream calls time out after 120 seconds, responses are limited to 4 MiB, and at most 4 calls per session and 8 per connector run at once.
- Recent calls record the session, agent, tool, outcome and duration for 30 days. Arguments, results and error text from the service are not recorded.

See [security boundaries](security.md#external-mcp-connectors) for what this protects against and what it does not.
