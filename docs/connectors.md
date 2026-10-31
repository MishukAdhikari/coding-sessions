# External MCP connectors

Coding Sessions can connect to remote MCP servers and let the agents it launches use tools you choose from them. Codex, Claude Code and Command Code sessions then share one managed connection per server instead of each signing in separately.

This is the reverse of [the MCP connector](mcp.md): that page covers apps connecting **to** Coding Sessions. This page covers Coding Sessions connecting **out** to other servers. The two use separate credentials, data and Settings screens.

## What is supported

- **Remote MCP servers over HTTPS** using the Streamable HTTP transport (JSON and server-sent-event responses), protocol revisions 2025-11-25, 2025-06-18 and 2025-03-26. Local (stdio) servers are not supported.
- **Tools only.** Coding Sessions lists and calls tools. A server's resources and prompts are not bridged, and requests a server makes back to its client (sampling, elicitation, roots) are not supported.
- **Bearer token or no authentication.** The token is sent as `Authorization: Bearer <token>`. Sign-in with OAuth is not supported yet.
- **Any number of servers**, each with its own name, URL, optional token and permanent tool prefix.

## Add a server

1. **Settings › Connections & access › External MCP connectors.**
2. Enter a **name**, the server's **URL** (for example `https://mcp.example.com/mcp`) and, if the server needs one, a **bearer token**. Choose **Add and test**.
3. The test lists the server's tools. The screen shows **Connected** only after that succeeds, and shows the server name and version only as the server reports them.

Adding a server grants nothing.

## Grant access

Access stays off until you grant it at each level:

- **Tools.** Tick the tools agents may use. Tools the server adds later stay off. A granted tool may read or change things on that server: the "read-only" and "may delete or overwrite" labels are the server's own annotations, shown for information and not verified. Agents receive the tools without those labels, so their own approval rules treat them as able to change things.
- **New sessions.** Per agent (Claude, Codex, Command Code), off by default.
- **Running sessions.** Per session. Only sessions started while a connector was enabled are listed; older sessions get the connector when you resume them.

Agents see the tools on an MCP server named `coding_sessions_connectors` as `<prefix>__<tool>`, plus `list_connections`, which reports what that session may use. The prefix is derived from the connector's first name and never changes, even if you rename it. A tool name with characters other than letters, digits, `_` and `-`, or one that would make the full name longer than 64 characters, gets a stable alias such as `prefix__files_read_1a2b3c4d`; the detail screen shows it. If two tools would end up with the same agent-facing name, neither can be granted.

## Changes and revocation

Every call is checked against the current settings: the session must be running, the connector enabled, the session granted, and the tool granted and still offered by the server. Disabling or removing a connector, replacing its token, changing its URL or removing a grant takes effect on the next call and cancels calls already running; their results are discarded even if access is restored before they finish. Cancelling cannot stop or undo something the server has already done: a write that reached the server may still complete.

**Changing the URL** removes the token and every tool grant, because the new URL may be a different server or account even on the same host. Enter the token again deliberately.

**Removing** a connector deletes its token and grants on this server immediately. It does not revoke the token with the service that issued it; do that there too if the token should stop working everywhere.

## Status meanings

| Status | Meaning |
|---|---|
| Not checked | Not tested since it was added or changed. |
| Connected | The last test reached the server and listed its tools. |
| Needs token | The server refused the request. Add or replace the token. |
| Access refused | The server refused access. Check the token and its permissions. |
| Refused | The destination was not allowed (see below). |
| Unavailable | The server could not be reached or answered unexpectedly. |
| Needs URL | A connector carried over from an earlier version has no URL yet. |
| Disabled | No session can use the connector. |

## Network rules

To keep a connector from being pointed at this machine or its private network:

- URLs must use `https://` and may not contain a user name, password, query or fragment.
- The host must resolve only to public addresses. Loopback, private, link-local (including cloud metadata such as `169.254.169.254`), carrier-grade NAT, unique-local, multicast and reserved ranges are refused, as are the IPv6 ranges that tunnel to IPv4 (6to4, Teredo, NAT64). An IPv4-mapped IPv6 address is judged as the IPv4 address it carries. Every connection resolves the name again and connects only to a vetted address, while certificate verification still uses the name you entered.
- Redirects are never followed.
- Requests are refused while `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` (any case) is set for the service, because a proxy would choose the destination itself. Run the service with direct outbound HTTPS.
- For local testing only, setting `CS_CONNECTOR_ALLOW_LOOPBACK=1` in the service environment allows `http://` and `https://` on loopback addresses. It cannot be enabled from the browser and never allows private networks.

Calls time out after 120 seconds, responses are limited to 4 MiB, and at most 4 calls per session and 8 per connector run at once.

## Requirements

- The server must have its token-encryption key (`LoadCredential=token-encryption-key` or `CS_TOKEN_KEY_FILE`). Without it, saving a token is refused; there is no plaintext fallback. Keep a protected copy of the key, separate from database backups: saved tokens cannot be recovered without it.
- Recent calls record the session, agent, tool, outcome and duration for 30 days. Arguments, results and error text from the server are not recorded.

## Collaboration skill

Managed launches install an app-owned skill, `coding-sessions-collaboration`, into `~/.claude/skills` and `~/.agents/skills`. It explains the difference between messaging (the communicator) and access (connectors), that a message never grants access, and the one-writer-per-shared-resource rule. A folder of the same name without the app's `.coding-sessions-owned` marker is left alone.

## Trust boundary

Tokens are encrypted at rest and are not passed to agents, but the service decrypts them to make requests, and its key is readable by the service account. Agents run under that same Unix account and can, with effort, read its files and processes. Connectors keep tokens out of agent prompts and configuration and keep grants enforceable for cooperating agents; they are not a sandbox against a hostile agent. See [security boundaries](security.md#external-mcp-connectors).
