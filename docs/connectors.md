# External MCP connectors

Coding Sessions can connect to remote MCP servers and let the agents it launches use tools you choose from them. Codex, Claude Code and Command Code sessions then share one managed connection per server instead of each signing in separately.

This is the reverse of [the MCP connector](mcp.md): that page covers apps connecting **to** Coding Sessions. This page covers Coding Sessions connecting **out** to other servers. The two use separate credentials, data and Settings screens.

## What is supported

- **Remote MCP servers over HTTPS**, in every MCP transport and protocol era (see [Transports](#transports)): stateless Streamable HTTP (2026-07-28), Streamable HTTP with sessions (2025-11-25, 2025-06-18, 2025-03-26), and the deprecated HTTP+SSE transport (2024-11-05, often a URL ending in `/sse`).
- **Local MCP servers (stdio):** a command Coding Sessions runs on this server, which only you can add, from Settings (see [Local commands](#local-commands-stdio)).
- **Tools only.** Coding Sessions lists and calls tools. A server's resources and prompts are not bridged, and requests a server makes back to its client (sampling, elicitation, roots, or a 2026 `input_required` result) are not supported: such a call fails with a clear message.
- **Ways to authenticate:** none, a bearer token you paste (sent as `Authorization: Bearer <token>`), [OAuth sign-in](#oauth-sign-in) in the browser with automatic refresh, and [extra headers](#extra-headers) such as `X-API-Key`. A pasted bearer token must be 8–4096 printable characters; tokens issued through OAuth must be 8–8192. A local command authenticates with secrets passed in its environment.
- **Any number of servers**, each with its own name, URL or command, optional token and permanent tool prefix.

## Transports

For a remote server, Coding Sessions tries the newest protocol first and remembers what worked:

1. **Streamable HTTP, 2026-07-28 (stateless).** It sends `server/discover`. Every request carries the protocol version and client details in `params._meta` and the headers `MCP-Protocol-Version`, `Mcp-Method` and, for `tools/call`, `Mcp-Name`. There is no `initialize` and no session. Cancelling a call closes its response.
2. **Streamable HTTP, 2025 revisions.** A server that does not recognize `server/discover` (a 400 with an empty or unknown body, 404, 405, method not found, or any other answer) is sent `initialize`, then requests with its `Mcp-Session-Id`; a 404 for that session starts a new one once. A 2026 server that refuses our version but lists a 2025 one it speaks is initialized with that. A 2026 server that lists only versions this app does not speak fails with that message and is not probed further.
3. **HTTP+SSE, 2024-11-05 (deprecated).** When `initialize` is refused with 400, 404 or 405, Coding Sessions opens a `GET` event stream. Its first event names the URL to post messages to, which must be on the **same origin** as the connector's URL (anything else is refused) and is checked by the same network rules. Replies arrive on the stream. If the stream ends, the next request starts a new session.

What a test negotiated shows in the connector's details, for example **Streamable HTTP (2026-07-28)**, **Streamable HTTP (2025-11-25)**, **HTTP+SSE (2024-11-05, deprecated)** or **stdio (2026-07-28)**. Test connection always probes again from the newest era, so an upgraded server is noticed; between tests, a session that fails on the remembered era negotiates once more.

A **local command** is probed the same way over stdio: `server/discover` first; a server that answers with a 2026 result is used statelessly; one that answers with an error, or not at all within 5 seconds, gets `initialize` and `notifications/initialized`.

## Local commands (stdio)

In **Add MCP connector**, choose **Local command (stdio)** and enter:

- **Command**: an absolute path, or a program name found on the service's `PATH` (for example `npx`). It must exist and be executable when you save it.
- **Arguments**, one per line. They are shown to you in the connector's details; do not put secrets in them.
- **Secrets passed as environment variables**: tick secrets from Settings › Secrets. Each is passed by name, under the same name. The connector stores only the names.
- **Working folder** (optional): an existing absolute path. Without one, the command runs in a private folder for this connector under the app's data folder.

Coding Sessions talks MCP to the command over its stdin and stdout (one JSON-RPC message per line). Anything the command writes to stderr is read and discarded, never treated as an error. A line on stdout longer than 4 MiB stops the command and fails the call as too large.

**Security model.**

- Only you can add a local command or change its command, arguments, secrets or folder, from your browser session in Settings, and only on the app's own origin. MCP tools, CLI tokens and the operator connection cannot, and an agent's `request_connector` can never ask for one (not even pending your approval): it accepts only `https://` URLs, and refuses to touch a connector that is a local command.
- The command runs as the service's own user, with only `PATH`, `HOME`, `LANG` and `TMPDIR` from the service environment plus the secrets you ticked. It never gets the server's own tokens or `CS_*` settings. Values of those secrets are scrubbed from everything it returns, like tokens.
- Each session that uses it (a running agent session, or the Settings check) gets its own process. A process idle for 10 minutes is stopped, as are all of them when the connector changes, is disabled or removed, and when the service stops: stdin is closed, then `SIGTERM` after 2 seconds, then `SIGKILL`.
- It is not a sandbox: the command can do whatever the service's user can. Add only programs you trust.

Changing the command, arguments, secrets or folder clears discovered tools and every tool grant, like a new URL.

## Extra headers

A remote connector can send extra HTTP headers with every request, for servers that want a key such as `X-API-Key`. Add them under **Extra headers** when adding the connector, or in its details. Values are encrypted like tokens, never shown again, and scrubbed from responses; the details show only the names. To keep a saved value, leave its field empty. Changing the URL removes the headers with the token.

Header names must be plain tokens (letters, digits and `-`), values one line of printable ASCII, at most 16 headers and 8 KB in all. Names Coding Sessions sets itself or that control the connection are refused: `Host`, `Content-Length`, `Content-Type`, `Accept`, `Accept-Encoding`, `Authorization` (use the bearer token or OAuth), `Connection`, `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`, `Expect`, `Last-Event-ID`, and any `Mcp-*`, `Proxy-*` or `Sec-*` header. `Cookie` and other application headers are allowed.

## Add a server

1. **Settings › Connections & access › External MCP connectors.**
2. Keep **Remote (HTTPS)** and enter a **name**, the server's **URL** (for example `https://mcp.example.com/mcp`) and, if the server needs one, a **bearer token** or [extra headers](#extra-headers). Choose **Add and test**. For a [local command](#local-commands-stdio), choose **Local command (stdio)** instead. For OAuth, add the server without a token, then choose **Sign in with OAuth** in its details.
3. The test lists the server's tools. The screen shows **Connected** only after that succeeds, and shows the server name and version only as the server reports them.

Adding a server grants nothing.

## Grant access

Access stays off until you grant it at each level:

- **Tools.** Tick the tools agents may use. Tools the server adds later stay off. A granted tool may read or change things on that server: the "read-only" and "may delete or overwrite" labels are the server's own annotations, shown for information and not verified. Agents receive the tools without those labels, so their own approval rules treat them as able to change things.
- **New sessions.** Per agent (Claude, Codex, Command Code), off by default.
- **Running sessions.** Per session. Only sessions started while a connector was enabled are listed; older sessions get the connector when you resume them.

Agents see the tools on an MCP server named `coding_sessions_connectors` as `<prefix>__<tool>`, plus `list_connections`, which reports what that session may use. The prefix is derived from the connector's first name and never changes, even if you rename it. A tool name with characters other than letters, digits, `_` and `-`, or one that would make the full name longer than 64 characters, gets a stable alias such as `prefix__files_read_1a2b3c4d`; the detail screen shows it. If two tools would end up with the same agent-facing name, neither can be granted.

## When an agent asks for a connector

An agent that needs a remote MCP server calls `request_connector {name, url, reason, auth}` on its communicator and gives you a one-time link (15 minutes). The page shows which session asks, why, and the server's host. With a token, you paste it (sending a token to a server always asks for your passkey first) and the app stores it like any connector token; with OAuth, **Sign in** runs the sign-in below in your own browser. This is the fix for MCP servers whose own sign-in redirects to `localhost` on the server: here the callback is the app's HTTPS address.

The app then checks the connection. Only a working connection completes the request: the connector is enabled for the requesting agent type, granted to the requesting session if it started with the connectors gateway, and all of its tools are granted. Narrow tools here afterwards. If the check fails, the link stays valid so you can fix the token and try again. A name that already belongs to a connector on another URL is refused. Agents follow it with `connector_status`.

## OAuth sign-in

In the connector's details, under **Authentication**, choose **Sign in with OAuth**, then **Apply** and **Sign in**. You approve access on the provider's page and come back to the connector's settings. Then test the connection and choose its tools.

**What the provider must support.** Coding Sessions discovers everything from the server: its protected-resource metadata (RFC 9728, from the `WWW-Authenticate` challenge or the well-known path), then the authorization server's metadata (RFC 8414 or OpenID Connect discovery). It requires:

- the metadata to name this connector's URL as the resource, or an ancestor of it on the same origin (Slack names `https://mcp.slack.com` for `https://mcp.slack.com/mcp`), and the exact issuer;
- S256 PKCE;
- issuer identification in sign-in responses (RFC 9207: `authorization_response_iss_parameter_supported`), or a registered client with a secret. With one callback shared by every provider, `iss` is what stops a malicious provider from mixing up sign-ins. A provider without it (Slack, for example) works only with a client you registered with it (client ID and secret under **Registered client**): a code captured by another provider's sign-in is useless without that secret, which only ever goes to its own provider. A response that does carry `iss` must name the expected issuer.

Sign-in requests the scopes the server asks for, adds `openid` when the provider supports it, and binds the request to this connector with a resource indicator (RFC 8707), sent exactly as the server's metadata names it.

**How this app is registered with the provider**, in this order:

1. **A client you registered yourself** (Authentication › Registered client), with the redirect URI shown there: `https://<your-instance>/oauth/connectors/callback`. It is pinned to one issuer; if the server later names a different provider, sign-in stops until you replace the client details.
2. **A client metadata document**, when the provider supports them: the provider fetches `https://<your-instance>/.well-known/oauth-client/coding-sessions.json`. Coding Sessions first fetches that URL itself, without credentials. If the answer is a login redirect or challenge, it uses dynamic registration instead (when offered) and tells you. This check cannot prove the provider's own fetch succeeds: providers fetch from their own addresses and can still be challenged.
3. **Dynamic registration** (RFC 7591), registering a web client with the exact redirect URI.

Otherwise the error names the exact redirect URI and metadata URL to register.

**After sign-in:** access tokens are refreshed automatically shortly before they expire, one refresh at a time per connector. A refresh that is rejected, or whose outcome is uncertain (a dropped connection, a redirect, an unexpected answer), is never retried with the old refresh token: the connector shows **Sign in again** instead. A request the server rejects with 401 is not repeated; the next one refreshes first.

**Account shown.** The account comes only from an OpenID Connect ID token that verifies (signature against the provider's published keys, issuer, audience, expiry and nonce). Otherwise the screen says **Account not reported**. "Signed in since" is when the sign-in completed here, not a date reported by the provider.

**Signing in again or with another account** keeps the current sign-in working until the new one completes; if you cancel, the provider refuses, or discovery fails, nothing changes. Only the latest attempt can complete. When it completes, the new sign-in replaces the old one here at once and this server's tool approvals are cleared; choose its tools again afterwards. The old sign-in is not revoked at the provider, because providers may treat both as one grant and revoke the new one with it. To end the old account's access at the provider, use **Disconnect** before signing in again, or remove access in the provider's own settings. Agent and session grants stay, and grant nothing on their own.

**Disconnect** ends local access first, then asks the provider to revoke the tokens (RFC 7009) and tells you whether it did, has no revocation endpoint, or did not confirm. If it did not, remove access in the provider's own settings.

**Behind Cloudflare Access (or a similar login gate).** Keep Settings, the callback and everything else behind it; the callback page needs your browser's normal access, and completing sign-in requires your Coding Sessions session. Only the client metadata document must be public, and only if you want providers to use it: the provider fetches it with no credentials, so it needs an Access policy that makes exactly `/.well-known/oauth-client/coding-sessions.json` public (a Bypass rule for that one path; a service-token rule does not work, because the provider cannot send those headers). Add a bot or WAF exception for that path only if a challenge blocks it. Keep every other path protected. Dynamic registration or a registered client works without it.

A provider that is itself behind Cloudflare Access cannot be used through a browser login alone: Coding Sessions calls its OAuth and MCP endpoints from the server, where your browser's Access cookie does not exist. The provider must expose those endpoints to machine clients with its own authorization.

**Logs.** The callback URL carries a one-time code and state in its query string. The bundled Nginx template turns off access and error logging for exactly `/oauth/connectors/callback` (so proxy errors for that one path are not logged); if you use another proxy, CDN, tracing or log pipeline, keep that path's query string out of its access, error and trace logs too. Completing the sign-in in Coding Sessions requires the browser session that started it. The code itself is short-lived and single-use, and the provider redeems it only together with the PKCE verifier (kept on this server) and any client credentials, but it should still never be stored.

## Changes and revocation

Every call is checked against the current settings: the session must be running, the connector enabled, the session granted, and the tool granted and still offered by the server. Disabling or removing a connector, replacing its token, changing its URL or removing a grant takes effect on the next call and cancels calls already running; their results are discarded even if access is restored before they finish. Cancelling cannot stop or undo something the server has already done: a write that reached the server may still complete.

**Changing the URL** removes the token and every tool grant, because the new URL may be a different server or account even on the same host. Enter the token again deliberately.

**Removing** a connector deletes its token and grants on this server immediately. It does not revoke the token with the service that issued it; do that there too if the token should stop working everywhere.

## Status meanings

| Status | Meaning |
|---|---|
| Not checked | Not tested since it was added or changed. |
| Connected | The last test reached the server and listed its tools. |
| Needs token / Needs sign-in | The server refused the request. Add or replace the token, or sign in again. |
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
- An HTTP+SSE server's message endpoint must be on the connector URL's own origin, and is vetted like the URL itself (it may carry a query, such as a session ID).
- Requests are refused while `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` (any case) is set for the service, because a proxy would choose the destination itself. Run the service with direct outbound HTTPS.
- For local testing only, setting `CS_CONNECTOR_ALLOW_LOOPBACK=1` in the service environment allows `http://` and `https://` on loopback addresses. It cannot be enabled from the browser and never allows private networks.

Calls time out after 120 seconds, responses are limited to 4 MiB, and at most 4 calls per session and 8 per connector run at once.

## Requirements

- The server must have its token-encryption key (`LoadCredential=token-encryption-key` or `CS_TOKEN_KEY_FILE`). Without it, saving a token is refused; there is no plaintext fallback. Keep a protected copy of the key, separate from database backups: saved tokens cannot be recovered without it.
- Recent calls record the session, agent, tool, outcome and duration for 30 days. Arguments, results and error text from the server are not recorded.

## Collaboration skill

Managed launches install an app-owned skill, `coding-sessions-collaboration`, into `~/.claude/skills` and `~/.agents/skills`. It explains the difference between messaging (the communicator) and access (connectors), that a message never grants access, and the one-writer-per-shared-resource rule. A folder of the same name without the app's `.coding-sessions-owned` marker is left alone.

## Trust boundary

Tokens (bearer tokens, OAuth access and refresh tokens, client secrets, extra header values) are encrypted at rest and are not passed to agents, but the service decrypts them to make requests, and its key is readable by the service account. Responses from the server are scrubbed of the token that was sent and of recently issued ones before anything is stored or forwarded; this stops a server from accidentally reflecting a token, not a server that deliberately encodes it. Agents run under that same Unix account and can, with effort, read its files and processes. Connectors keep tokens out of agent prompts and configuration and keep grants enforceable for cooperating agents; they are not a sandbox against a hostile agent. See [security boundaries](security.md#external-mcp-connectors).
