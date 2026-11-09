# Security and operational boundaries

## Intended trust boundary

Coding Sessions is a remote execution control panel for one trusted operator per Unix account and instance. Browser sessions, CLI tokens, and authorized MCP clients can exercise that account's application capabilities. A provider, custom command, repository build script, or terminal shell may access anything the account can access.

The installer separates instances with distinct Unix accounts, private homes, configuration, and state. It does not isolate projects or sessions within one account, protect against host root, or provide a hostile multi-tenant platform. A UI project allowlist is not a filesystem sandbox. Do not share an account with unrelated people or claim that one session's secrets are hidden from another.

Use a dedicated VM for an untrusted workload. A stronger service-to-runner boundary needs a separate architecture and verification; installing systemd hardening flags does not establish it.

## Network and access

Terminate HTTPS at a trusted reverse proxy and keep the application listener inaccessible to untrusted direct clients. Forward WebSocket upgrades for terminals. Enable `CS_TRUST_PROXY=1` only when the proxy overwrites forwarded client headers and clients cannot bypass it.

`CS_ACTIVITY_PORT` (off by default) opens a second listener on `127.0.0.1` with one route, `GET /activity`, and no sign-in. It is for an idle check on the same machine, such as one that stops or suspends a server nobody is using. It returns whether anything is active and when it last was: agents working or starting, agents waiting for an answer or approval, and web terminals with a browser attached. It shows counts only, no session names, repositories or content. Any local account on the machine can read it, so do not enable it where that timing is sensitive, and never route the proxy to this port. `sudo coding-sessions activity --json` prints the same answer, and fails while the signal is off.

```json
{"active":false,"working":0,"waiting":0,"terminals":0,"last_activity_at":"2026-11-05T11:32:49.205Z","idle_seconds":120}
```

`CS_RESUME_AFTER_BOOT=1` (off by default) resumes sessions after the machine reboots, or after a sandbox wakes, which is the same thing to the server: the disk is kept and every running agent is gone. Right after the server starts it resumes each Claude, Codex and Command Code session that was running when the machine went down, under its own name, in its own folder, with the permissions the server is set to. Nobody has to open the app first, so agents start working again unattended; leave it off if that is not what you want. A session you ended stays ended, and so does one whose agent exited by itself while the machine and the service were up (the server checks every minute while this is on). A restart of the service alone resumes nothing, since sessions survive it. In a container the boot time is the host's, so a container restart ends sessions and does not resume them. A Codex session counts as resumed once Codex confirms the same conversation. Each session is tried once: one whose folder or conversation is gone stays in history, and the service log (`journalctl`) has a `boot resume:` line for every session it resumed or skipped. The boot time comes from `/proc/stat`, so on other systems the setting does nothing.

Register a passkey after initial password sign-in. An MCP authorization is access to this instance, not permission to one isolated project. Review client consent and revoke unused CLI/OAuth access. Report suspected vulnerabilities privately using [SECURITY.md](../SECURITY.md).

### Local control socket

`CS_SOCKET=1` or `CS_SOCKET_PATH` (off by default) serves the MCP tools on a Unix socket with no sign-in ([details](socket.md)). The socket is 0600 in a 0700 folder owned by the service account, so the service account and root can use it, and no other local account can. It never listens on TCP.

Enabling it gives every program running as the service account full operator control, with no token. That includes every agent in every Session: any of them can launch and end Sessions, type into another Session, answer its approval prompts with `press_keys`, and sign agent accounts in or out with `agent_auth`. Without the socket, an agent would need to tamper with the account's files to get the same reach, which the trust model above already allows. With it, a single line of JSON is enough, so a prompt-injected agent no longer has to work for it. The communicator's separation from the operator endpoint (see [Session communication](#session-communication)) does not hold for an instance with the socket on. Turn it on only where every agent the instance runs is trusted with operator control.

## Secret map

| Secret or configuration | Handling and limitation |
|---|---|
| Non-secret configuration | `.env` or systemd `EnvironmentFile`; contains hostnames, paths, and behavior switches |
| Administrator bootstrap password | Installer creates a root-private file delivered through `LoadCredential=admin-password`; SQLite stores a password hash |
| Local bootstrap password | Without a supplied credential, first startup writes a private `CS_DATA_DIR/bootstrap-password`; logs contain only its location |
| App token encryption key | `LoadCredential=token-encryption-key` or `CS_TOKEN_KEY_FILE`; canonical base64 encoding of exactly 32 random bytes |
| Custom-command and app-managed Command Code tokens | Versioned AES-256-GCM ciphertext when a key is configured; random nonce and context-bound authentication prevent swapping ciphertext between commands/credential purposes |
| Native provider and GitHub authentication | CLI-managed files in the instance home; not automatically encrypted by the application's token encryption |
| Browser sessions, CLI bearer tokens, OAuth codes/access/refresh tokens | Hashes in SQLite; raw bearer values still require protection wherever the client stores them |
| `cs` browser sign-in codes | Hashes in memory only, single use, 10 minutes, rate-limited per address. The short code shown to you is not a credential: only a signed-in browser on the app's origin can allow it, and the token is handed to `cs` once, never in a URL |
| Built-in communicator credentials | Random per-launch capabilities; only hashes are stored in SQLite, with raw values passed through explicit child environment. They cannot authenticate to the operator MCP endpoint. |
| External MCP connector tokens (bearer tokens; OAuth access and refresh tokens, client secrets and PKCE verifiers) | AES-256-GCM ciphertext bound to the connector, its sign-in epoch and the secret's purpose; saving is refused when no key is configured (no plaintext fallback). Write-only over the API, opened only to make an upstream request, never passed to agents. Pending sign-ins store only a hash of their state. |
| Secrets (Settings › Secrets) and secret-manager credentials | AES-256-GCM ciphertext bound to the secret name or source; saving is refused without a key. Write-only over the API (names and timestamps only), browser session and same Origin required. Values reach every new managed session through its environment, never argv; names the shell, loader or session plumbing depend on (`PATH`, `LD_*`, `CS_*`…) are refused. Each source keeps a sealed snapshot of its last sync, used when it is unreachable. |
| Connector launch capabilities | Random per-launch `csconn_` values, hashed in SQLite, passed through explicit child environment. A separate audience from the communicator and the operator endpoint. |
| Workspaces, transcripts, setup logs, backups, Chat (ACP) event logs (`CS_DATA_DIR/acp/`) | May contain secrets or source code; not automatically encrypted or redacted as a whole |

The protected-file reader rejects final-component symlinks, nonregular files, group/other permissions, and oversized files. Protect the containing directories too. The installer provisions root-private source credentials; the runtime receives readable snapshots for its service identity.

`LoadCredential` reduces accidental environment propagation. It does not hide credentials from descendant code sharing the service identity and namespace. Exporting credential contents into a broad environment undoes that advantage. Systemd documents activation-time credential snapshots and the service-user access model. [Systemd credentials](https://systemd.io/CREDENTIALS/)

Environment secrets can spread into child processes and diagnostics. Linux `/proc/PID/environ` access is permission-checked, so the claim that every local user can read every process environment is inaccurate. [Linux environment interface](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html), [OWASP secret management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)

## Defaults and compatibility

Configuration and new managed launches use the `CS_` prefix. Earlier prefixed settings remain readable during upgrades; `CS_` takes precedence. Existing encrypted tokens and live Codex launches remain compatible. Update the root-owned managed hook alongside the application before starting new Codex sessions.

New deployments use `CS_AGENT_PERMISSIONS=standard`: the application does not add provider bypass flags. The mode can be changed in Settings → Server settings only by a browser session that has just confirmed with its passkey (or the admin password when no passkey exists); CLI and connector tokens cannot change it, and running sessions keep the mode they started with. Provider settings and tool-specific policies still matter. `CS_CHILD_ENV=filtered` forwards operational variables and explicit per-provider values instead of the whole service environment. The filter is exposure reduction, not isolation from account-owned files or SSH-agent access.

Explicit `unrestricted` and `inherit` modes support deliberate legacy behavior. Review them before enabling either. No credential-pointer filtering can make arbitrary same-account shell access safe for mutually untrusted users.

In `unrestricted` mode, managed Codex launches and resumes automatically trust the selected project folder, including its project configuration. Trust is passed for that invocation only; the application does not rewrite Codex's user configuration or trust the entire workspace parent. Standard mode keeps Codex's folder-trust confirmation. Managed hook validation remains enabled in both modes.

With no configured token key, legacy app-token reads and writes remain plaintext-compatible. Configuring a key encrypts new writes, while existing plaintext rows remain readable. There is no automatic database or backup migration. An encrypted value with a missing/wrong key, wrong context, or failed authentication cannot be delivered as a token.

## Backup and recovery

Back up the instance data directory, relevant provider configuration and workspaces, root-owned instance configuration, both credential files, and the release identity. Treat all of these backups as sensitive. Use a SQLite-aware consistent backup or a maintenance window; copying only `app.db` during writes can omit committed WAL contents.

Keep a protected, recoverable copy of the token encryption key separately from the database backup. Losing the key makes encrypted app tokens unrecoverable; restore the matching key or re-enter each token. Native provider login files and hashed client tokens have separate recovery/revocation needs.

There is no automatic encryption-key rotation command. Do not overwrite the key and restart as a rotation procedure: old ciphertext requires the old key. A planned rotation needs authenticated re-encryption of existing values or deliberate token re-entry, consistent backups, and validation before retiring the old key. The process caches its key, so a file replacement alone does not update a running process.

The administrator password file is bootstrap input, not a continuously synchronized password setting. Changing it does not replace an existing password hash. Preserve a working passkey and recovery access; perform an explicit reviewed recovery procedure if both are lost. Never publish database exports or bootstrap files to request help.

## Service hardening and detached sessions

The installer uses a non-root account with no sudo grant, root-owned application releases, private state, and systemd restrictions. Provider installation/update helpers run as the instance user. These measures limit incidental damage while keeping shells, PTYs, networking, and builds usable.

Detached sessions intentionally outlive web-service restarts. The unit therefore uses `KillMode=process`, which systemd discourages for general services because descendants can remain outside the expected stop lifecycle. End and verify sessions explicitly before retiring an instance; a stopped web service is not proof that all agent processes stopped. [Systemd process lifecycle](https://www.freedesktop.org/software/systemd/man/255/systemd.kill.html)

Do not add blanket namespace restrictions or executable-memory denial without testing provider sandboxes and JIT runtimes. Do not relax filesystem ownership, grant sudo, or expose privileged daemon sockets merely to make a failing workflow work. Systemd options can affect descendants and must be tested on both supported Ubuntu releases. [Systemd execution settings](https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html)

### herdr backend

With `CS_MUX=herdr`, the app runs its own herdr session and talks to it over herdr's Unix socket (`~/.config/herdr/sessions/coding-sessions/herdr.sock`, mode 0600). herdr opens no TCP port. Each launch's environment, including stored secrets and communicator tokens, goes in the socket request and reaches only that pane's process. It is never passed as `--env KEY=VALUE`, where `ps` would show it. The herdr server itself starts with a minimal environment, so panes get their variables from the launch alone. herdr also sets `HERDR_SOCKET_PATH` in every pane, so an agent can use herdr's API to read or type into the other sessions and to start panes. That is the same reach `zmx send` and `screen -X` already give any process of the service account; it is not a new boundary, but it is advertised.

The app writes its herdr config (`herdr.toml` under `CS_RUNTIME_DIR`) and passes it to every herdr process it runs. That config turns off herdr's background version and agent-manifest checks against herdr.dev, and its own agent restore. It also moves herdr's prefix key off ctrl+b, which agents use. Pane screen history stays off, herdr's default.

herdr saves each pane's launch command, not its environment, in `session.json` and in up to 48 `session-snapshots/` files under `~/.config/herdr/sessions/coding-sessions/`. That includes past sessions' repository, paths and agent arguments. Treat that directory as private session data. After a herdr restart, herdr restores those panes as plain shells. The app does not count them as sessions and closes them on its next launch.

## Optional claude.ai browser integration

The separate chat-management browser login requires an explicit `CAI_EMAIL` and a provisioned Playwright Chromium/Xvfb runtime. The standard installer does not install that optional browser stack. The email is passed only to the login process; no personal account is assumed. Its persistent browser profile is sensitive account state, separate from Claude Code authentication.

## Existing production deployments

The installer refuses to adopt unmanaged accounts and paths. A legacy deployment may depend on inherited environment values, an existing host-wide Codex policy, custom update control privileges, or detached sessions. Inventory these dependencies, back up state and keys, and plan migration explicitly. Do not run a fresh-instance installer over a live personal deployment or silently change its approval posture.


## Session communication

The built-in communicator has a separate credential audience and five mailbox tools. It derives sender identity from the current launch credential, restricts inbox/history reads to that participant, and binds messages to immutable launch UUIDs. Ending, failing, or replacing a launch invalidates access; service restarts preserve access for surviving launches. The bridge accepts only this instance's numeric-loopback HTTP endpoint and refuses redirects.

Messages are stored in the private application database for 30 days. They are not encrypted separately from that database and may contain source code or sensitive text. Treat database backups accordingly. Message attribution is not authorization: a peer cannot grant additional task scope or override provider approvals. No messages are injected into terminal input or approval dialogs.

These controls prevent accidental use of the administrative connector and cross-mailbox reads through the communicator API. The [local control socket](#local-control-socket), when enabled, gives agents the administrative tools directly. They do not isolate malicious programs sharing the Unix account: such programs may access other process environments or account-owned files. Use separate Unix accounts/instances or VMs for mutually untrusted agents.

## Chat view

The chat view (`chat.html`, "Open chat" on a running session) reads the agent's own transcript and needs the same sign-in as the rest of the app. `GET /api/sessions/:id/transcript` takes only a managed session id (`m:cs-…`) and a byte cursor. The file is chosen from that session's own records and nothing else: for Codex, the conversation UUID its SessionStart hook reported, matched against the rollout's `session_meta` under `~/.codex/sessions` (or a `CODEX_HOME` forwarded to sessions); for Claude Code, the transcript id stored on its launch, under `~/.claude/projects`. The real path must stay inside that folder, so a symlink out of it is refused. Responses are not cached and are bounded: 200 messages, 8,000 characters each, and lines over 1 MiB (large tool output) are skipped. For these transcript chats, tool output and reasoning are never sent. Command Code and registered Commands have no transcript chat view, because their transcript formats are not verified; they can run in Chat (ACP) mode instead (below).

`POST /api/sessions/:id/message` types the reply into the session through the same path as the MCP `send_message` tool (`zmx send`, or `screen -X stuff` for older sessions). Like that tool, the reply text appears on that command's argument list for the moment it runs, so don't paste secrets into the chat. The page sets all transcript text as plain text, never as HTML.

### Chat (ACP) mode

A session launched in Chat (ACP) mode runs a bridge (`server/acp/bridge.ts`) inside its holder, not inside the server, and the bridge runs the agent. Its files live in `CS_DATA_DIR/acp/cs-<name>/`, a 0700 folder owned by the service account:

- `bridge.sock`, a 0600 Unix socket that takes three commands: prompt, cancel, and a permission answer. Nothing listens on TCP. The server connects only to the socket derived from a session's own holder name, after checking that the session is a Chat launch, and refuses a folder that is a symlink, belongs to another account or is open to group or others. Socket paths of 100 bytes or more are refused at launch.
- `events.jsonl`, an append-only 0600 log of what the chat shows: your prompts, the agent's updates (messages, reasoning, tool calls with their input and output, diffs, plans), permission requests and answers. Unlike transcript chats, this includes raw tool output and reasoning, so it can hold secrets that the agent's tools print. It is replaced when a session with the same name launches again, and removed when you delete the session from history.
- `state.json`, the bridge's current state.

`GET` and `POST /api/sessions/:id/acp` need the same sign-in as the rest of the app; the POST also passes the same-origin check as every API write. Prompts are capped at 16 KiB, and the page renders agent text as text: markdown is parsed into elements built one by one, never assigned as HTML, and links are kept only for `http`, `https` and `mailto`.

The bridge's settings, the provider credential, stored secrets and the communicator token reach it through the holder's environment, never argv. The bridge removes its own settings before starting the agent and passes the rest on, as a terminal launch does. The communicator entry goes to the agent in its ACP `session/new` request, with values filled in from that environment. The bridge never writes these values to its log or state file; what an agent does with session parameters it stores for `session/load` is up to the agent. The client capabilities offered to the agent are only those implemented: no file-system or terminal access through the bridge.

Like `zmx send`, `screen -X` and herdr's socket, the bridge socket is usable by any process of the service account, including the session's own agent and its tools. Such a process can answer that session's permission requests and send prompts, so permission cards are not a boundary against a compromised agent; the trust model above already allows that reach.

## Secrets for sessions

Settings › Secrets stores named values (API tokens, keys) and delivers them to **every** new managed session, Claude, Codex, Command Code and registered Commands alike, as environment variables. Precedence, lowest first: secret-manager values in the order the managers were added, values stored in the app, the provider's own credential (a Command's token, the Command Code key, a preset's launch settings), then session plumbing (`CS_COMMUNICATOR_*`, `CS_CONNECTOR_*`). A running session's environment keeps the values it started with.

### Secrets file for running sessions

Each managed launch also gets `CS_SECRETS_FILE`, a file of `export NAME='value'` lines holding the same stored secrets. The app rewrites it atomically (temporary file, then rename) whenever a secret or a secret manager changes and whenever a secret request is fulfilled, so a secret saved after a session started still reaches it; deleting a secret removes it from every file. Agents read one name from it in a subshell rather than printing it. The communicator's `secret_status` reports whether the session's own environment has the current value (`current`, `outdated`, `missing`) by comparing keyed hashes recorded at launch; the hashes use a random per-process key and live only in memory, so after a server restart the answer is `unknown`.

Trust model: the file is readable only by the service account (directory `0700`, file `0600`), the same account that can already read every session's environment through `/proc/<pid>/environ`. It is the same boundary as environment delivery, not a new one, and every session gets every secret, as before. The files hold plaintext, so they are kept out of the backed-up data directory: in `CS_RUNTIME_DIR`, else `XDG_RUNTIME_DIR`, else the service's private `/tmp` (`PrivateTmp=yes` in the systemd unit). They are rebuilt for running sessions when the server starts, swept every minute, and a session's file is removed once the session is gone. A file that cannot be rewritten is deleted rather than left stale. Secret-manager values in the file come from the last sealed snapshot; writing the file never forces a fetch.

### Secret and connector requests

An agent that needs a value calls `request_secret` (or `request_connector` for an MCP server) instead of asking in chat. The app returns a link, `https://<origin>/#secret-request=<token>`:

- The token is 32 random bytes. Only its SHA-256 is stored, and the hash is cleared the moment the request leaves `pending`, whether it was fulfilled, declined, replaced by a newer request or expired. Links last 15 minutes and work once.
- The token is in the URL fragment, which browsers never send to a server, so it does not reach proxy or Cloudflare logs; the page reads it, removes it from the address bar and history at once, and sends it only in same-origin POST bodies.
- Opening the link needs a signed-in browser session; CLI tokens and MCP clients can create requests and read their status, never answer them. A signed-out member signs in first and continues to the same request.
- Each session may have 3 requests pending and create 10 per 10 minutes; at most 20 are pending in total. A new request for the same name replaces the older link.
- Request names follow the Secrets rules (reserved names such as `PATH`, `LD_*` and `CS_*` are refused). The reason is plain text, at most 500 characters, with control and bidirectional-override characters removed, and the page renders everything as text.
- Server log lines carry the request id, kind, name, requesting session and outcome. Never a value, a token or the reason.

**Threat model.** A request page is a social-engineering surface: its reason is written by an agent, and a prompt-injected agent could ask for a credential it has no business holding, or name a convincing reason. A pasted value is new to the system and becomes readable by every session, including ones already running. The page therefore shows, in text the agent cannot change, which session is asking (or that the request came through the operator connection, with any named session as secondary context), that every session will be able to read the value, and the name; it never prefills the field and keeps browser autofill out of it. Overriding a name that already has a value, from the app or from a secret manager, needs an explicit **Replace** and a passkey (or admin password) step-up.

`request_connector` names a URL chosen by the agent, and a bearer token entered there is sent to that server, outside this system. The page states the destination host in a fixed sentence, the URL must pass the connector rules (HTTPS, public addresses only), a connector name that already points elsewhere is refused, and sending a token always needs a step-up. Tools are granted to the requesting agent type, and to the requesting session when it has the connectors gateway, only after a successful connection check; narrow them in Settings › Connectors. OAuth requests use the existing connector sign-in, whose callback is this app's own HTTPS origin.

### Restart with new secrets

A program that read its environment once (an MCP server the agent started, a dev server) does not see a new value. **Restart with new secrets** (session sheet, operator MCP `restart_session`) ends the session and resumes the same conversation, so the agent and everything it starts again get the current environment. Everything running in the session stops. It is refused, with nothing ended, when the session could not come back: registered Commands in terminal mode, a missing folder, or no saved conversation yet.

Secret managers are read with a dedicated, least-privilege credential: a Bitwarden Secrets Manager machine-account access token (read by the `bws` CLI, which must be installed on the server; the token reaches it through its environment), an Infisical machine identity using Universal Auth, or a Vault/OpenBao token for one KV v2 path. A source is saved only after a successful first fetch. Sources are refetched at launch when their last sync is older than five minutes, so an unreachable manager can delay a launch by up to ten seconds; on failure the last sealed snapshot is used and the error is shown in the sheet. Infisical and Vault requests use the connector transport (HTTPS, public addresses only, no redirects, no proxies), so a self-hosted manager on a private network is not reachable; local testing can use `CS_CONNECTOR_ALLOW_LOOPBACK=1`. `bws` makes its own connections and is not covered by those checks.

The trust model is unchanged: every agent under the service account can read every secret delivered to it. Store only what you would give every session, and prefer narrowly scoped tokens.

## External MCP connectors

Outbound connectors ([details](connectors.md)) keep each server's credential (a bearer token or an OAuth grant) in the service and give each launch its own capability. The gateway checks liveness, connector state, launch grant and tool grant on every call, cancels running calls when access changes, and discards results that finish after a revocation. Upstream error text is replaced by local messages, and every server response is scrubbed of the token actually sent and recently issued ones (raw reflection only; a server that encodes a token deliberately is outside this protection). Tool annotations from servers are shown to the operator as claims and are not passed to agents.

Destinations must be HTTPS and resolve only to public addresses. Each connection resolves the name, refuses any non-public answer, and connects to a vetted address with certificate verification against the entered name (explicitly enabled, so `NODE_TLS_REJECT_UNAUTHORIZED=0` cannot disable it). Redirects are refused, and connector requests are refused while proxy variables are set, because Bun applies them to every request and a proxy would pick the destination. A URL change clears the token and tool grants; a client bound to an old URL or token cannot send another request.

OAuth sign-in follows RFC 9700: S256 PKCE, exact issuer and resource matching, RFC 9207 issuer identification required, a single-use state bound to the initiating browser session and to the connector's sign-in epoch, and a callback page that only moves the code to a same-origin POST that requires the app session and the exact Origin. Starting a sign-in changes nothing until it completes; each start takes a new attempt number, only the latest attempt can create its pending sign-in, complete, or commit, and its verified grant replaces the previous one atomically on a new epoch with tool approvals cleared. Replacement is local: the previous grant is not revoked at the provider (it may share a grant family with the new one); Disconnect revokes explicitly. Any change of URL, mode, client or account starts a new epoch, so late responses cannot restore access. Refresh is single-flight with versioned writes; uncertain outcomes require a new sign-in instead of retrying a possibly rotated token. ID tokens are verified against the provider's published keys before an account is shown.

All of this assumes the deployment's trust model: one administrator and trusted agents sharing a Unix account. The token is decrypted inside the service process, and the encryption key is readable by that account. Encryption protects database copies and backups that are kept without the key; it does not protect against running agents. For mutually untrusted agents, run separate instances under separate accounts or machines.
