# Security and operational boundaries

## Intended trust boundary

Coding Sessions is a remote execution control panel for one trusted operator per Unix account and instance. Browser sessions, CLI tokens, and authorized MCP clients can exercise that account's application capabilities. A provider, custom command, repository build script, or terminal shell may access anything the account can access.

The installer separates instances with distinct Unix accounts, private homes, configuration, and state. It does not isolate projects or sessions within one account, protect against host root, or provide a hostile multi-tenant platform. A UI project allowlist is not a filesystem sandbox. Do not share an account with unrelated people or claim that one session's secrets are hidden from another.

Use a dedicated VM for an untrusted workload. A stronger service-to-runner boundary needs a separate architecture and verification; installing systemd hardening flags does not establish it.

## Network and access

Terminate HTTPS at a trusted reverse proxy and keep the application listener inaccessible to untrusted direct clients. Forward WebSocket upgrades for terminals. Enable `CS_TRUST_PROXY=1` only when the proxy overwrites forwarded client headers and clients cannot bypass it.

Register a passkey after initial password sign-in. An MCP authorization is access to this instance, not permission to one isolated project. Review client consent and revoke unused CLI/OAuth access. Report suspected vulnerabilities privately using [SECURITY.md](../SECURITY.md).

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
| Built-in communicator credentials | Random per-launch capabilities; only hashes are stored in SQLite, with raw values passed through explicit child environment. They cannot authenticate to the operator MCP endpoint. |
| Workspaces, transcripts, setup logs, backups | May contain secrets or source code; not automatically encrypted or redacted as a whole |

The protected-file reader rejects final-component symlinks, nonregular files, group/other permissions, and oversized files. Protect the containing directories too. The installer provisions root-private source credentials; the runtime receives readable snapshots for its service identity.

`LoadCredential` reduces accidental environment propagation. It does not hide credentials from descendant code sharing the service identity and namespace. Exporting credential contents into a broad environment undoes that advantage. Systemd documents activation-time credential snapshots and the service-user access model. [Systemd credentials](https://systemd.io/CREDENTIALS/)

Environment secrets can spread into child processes and diagnostics. Linux `/proc/PID/environ` access is permission-checked, so the claim that every local user can read every process environment is inaccurate. [Linux environment interface](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html), [OWASP secret management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)

## Defaults and compatibility

Configuration and new managed launches use the `CS_` prefix. Earlier prefixed settings remain readable during upgrades; `CS_` takes precedence. Existing encrypted tokens and live Codex launches remain compatible. Update the root-owned managed hook alongside the application before starting new Codex sessions.

New deployments use `CS_AGENT_PERMISSIONS=standard`: the application does not add provider bypass flags. Provider settings and tool-specific policies still matter. `CS_CHILD_ENV=filtered` forwards operational variables and explicit per-provider values instead of the whole service environment. The filter is exposure reduction, not isolation from account-owned files or SSH-agent access.

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

## Optional claude.ai browser integration

The separate chat-management browser login requires an explicit `CAI_EMAIL` and a provisioned Playwright Chromium/Xvfb runtime. The standard installer does not install that optional browser stack. The email is passed only to the login process; no personal account is assumed. Its persistent browser profile is sensitive account state, separate from Claude Code authentication.

## Existing production deployments

The installer refuses to adopt unmanaged accounts and paths. A legacy deployment may depend on inherited environment values, an existing host-wide Codex policy, custom update control privileges, or detached sessions. Inventory these dependencies, back up state and keys, and plan migration explicitly. Do not run a fresh-instance installer over a live personal deployment or silently change its approval posture.


## Session communication

The built-in communicator has a separate credential audience and five mailbox tools. It derives sender identity from the current launch credential, restricts inbox/history reads to that participant, and binds messages to immutable launch UUIDs. Ending, failing, or replacing a launch invalidates access; service restarts preserve access for surviving launches. The bridge accepts only this instance's numeric-loopback HTTP endpoint and refuses redirects.

Messages are stored in the private application database for 30 days. They are not encrypted separately from that database and may contain source code or sensitive text. Treat database backups accordingly. Message attribution is not authorization: a peer cannot grant additional task scope or override provider approvals. No messages are injected into terminal input or approval dialogs.

These controls prevent accidental use of the administrative connector and cross-mailbox reads through the communicator API. They do not isolate malicious programs sharing the Unix account: such programs may access other process environments or account-owned files. Use separate Unix accounts/instances or VMs for mutually untrusted agents.
