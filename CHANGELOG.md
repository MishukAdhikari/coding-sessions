# Changelog

What changed in each release, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions are the `vX.Y.Z` tags
on [GitHub Releases](https://github.com/MishukAdhikari/coding-sessions/releases), where each
release also lists how it was validated.

## [Unreleased]

## [0.22.4] - 2026-11-27

### Fixed
- OAuth sign-in for an MCP connector works with authorization servers that do not identify
  themselves in sign-in responses (RFC 9207), such as Slack's, when the connector has a registered
  client with a secret. Before, sign-in stopped with "This authorization server does not identify
  itself in sign-in responses". Without a registered confidential client such servers are still
  refused, and a response that carries `iss` must still name the expected issuer.

## [0.22.3] - 2026-11-26

### Fixed
- OAuth sign-in for an MCP connector works with servers that name their origin as the protected
  resource, such as Slack (`https://mcp.slack.com` for `https://mcp.slack.com/mcp`). Before, sign-in
  stopped with "The server's protected-resource metadata names a different resource." The resource
  must still be the connector's URL or an ancestor of it on the same origin, and it is sent back as
  the resource indicator exactly as the server names it. Slack also needs a registered client (its
  app's client ID and secret) under **Registered client**, because it offers no automatic
  registration.

## [0.22.2] - 2026-11-21

### Fixed
- In a Chat (ACP) session, a message sent while the agent is working is queued and shown in
  the chat marked **Queued**. It is sent when the current turn ends. Before, Enter did nothing
  while the agent worked and the message never appeared. With text in the composer the button
  is Send; with the composer empty it is Stop. Stop also drops anything still queued.

## [0.22.1] - 2026-11-19

### Changed
- The app opens on the **Active** tab again (0.21.1 made it All). The tab you pick is kept
  until you reload.

## [0.22.0] - 2026-11-19

### Added
- `coding-sessions setup` installs on servers where nginx already serves ports 80/443, as on
  servers a hosting panel built. It adds Coding Sessions to that nginx as one more site,
  checks it with `nginx -t`, and gets the certificate with certbot. Before, setup stopped
  with "port 80 is used by nginx". `--proxy auto|caddy|nginx` picks one; `auto`, the
  default, uses the Caddy or nginx already there, else installs Caddy as before. `status`,
  `doctor` and `uninstall` follow the choice, which re-runs remember.

## [0.21.1] - 2026-11-19

### Changed
- The app opens on the **All** tab: live and ended sessions together. The tab you pick is
  kept until you reload.

### Removed
- The **Board** tab and `GET /api/board` from 0.21.0. `cs live --all` is unchanged.

## [0.21.0] - 2026-11-18

### Added
- **Board** tab in the app: the live sessions grouped into Needs you, Cooking and Idle, each
  card with its question, or the first sentence or two of its last reply (or its last tool
  call). It is the same view as `cs live --all`, for this server. It refreshes every 8 s
  while open and costs nothing while closed. `GET /api/board` returns each session's group
  and summary.

## [0.20.1] - 2026-11-18

### Fixed
- Chat view and `cs live`: a message sent to Claude Code while it was still answering the
  previous one disappeared from the chat, although Claude got it and answered. Claude Code
  records such a message as a queued command, which the transcript reader skipped. It now
  shows as your message, at the time you sent it.

## [0.20.0] - 2026-11-17

### Added
- OpenCode Go (and OpenCode Zen) for the opencode preset. Store the subscription's API key
  from opencode.ai/auth with **Add key** or **Manage token**. Sessions get it as
  `OPENCODE_API_KEY` and opencode offers the `opencode-go/*` models, without signing in
  in a terminal. An opencode Command added before this picks up the key variable on its own.

## [0.19.2] - 2026-11-17

### Added
- The doctor checks the claude.ai browser sign-in: claude.ai refused the server's browser,
  the login expired, not signed in, or deletions failed, each with how many chat deletions
  are waiting and what to do. It stays quiet when the feature isn't used.
- `cs doctor` on your laptop also shows the server's own doctor findings: warnings with
  their fix, and failures counted in its exit code.

## [0.19.1] - 2026-11-17

### Fixed
- Claude.ai browser sign-in: when claude.ai refuses the server's browser ("Couldn't verify
  your browser"), the sheet says so at once. Before, it showed a human check with nothing to
  solve, then reported after six minutes that the check wasn't finished in time.

## [0.19.0] - 2026-11-17

### Added
- `cs live --all` (`-A`, or `cs --live --all`): one board of every session on every saved
  server, grouped into Needs you, Cooking and Idle. Each session shows its question, or the
  first sentence or two of its last reply, plus server, uptime and newest PR. A server that
  doesn't answer gets one line. `--json` gives the same data.

## [0.18.0] - 2026-11-17

### Added
- `cs list --all` (`-A`): running sessions on every saved server in one list, each row
  naming its server; a server that does not answer shows as one unreachable line.
- MCP `list_sessions` and `server_status` carry `server.url`, so an agent connected to
  several servers can tell which one answered.

### Fixed
- An agent connection added with `cs mcp add` keeps its name and server. Before,
  `cs server use` made `coding-sessions` mean the new default, so `cs mcp add` could
  overwrite another server's connection and `cs mcp status` reported a connection to
  the wrong server as fine. `cs mcp status` now says when a connection points at another
  address. Connections added earlier are recognised by their address. One server works
  exactly as before.

## [0.17.1] - 2026-11-17

### Fixed
- The disk size under the host meters is the disk's whole size, as `df` and the
  provider's plan state it (75 GB, not the 71.7 GB left after root's reserve).

## [0.17.0] - 2026-11-17

### Added
- The server's size under the CPU, RAM and disk meters, read once at start:
  "4 cores · 7.6 GB RAM · 75 GB disk" ("4 cores · 7.6G · 75G" on a phone). The host
  stats in `/api/sessions` and MCP `list_sessions` carry `cpuCores` and `diskTotalGb`.

## [0.16.2] - 2026-11-17

### Fixed
- Chat replies and MCP `send_message` on screen-held sessions: a message longer than
  about 1 KB never reached the agent although the chat showed it sent, `^C` in the text
  pressed Ctrl-C, and `$NAME` was replaced by the server's environment. Text now goes in
  through screen's paste buffer, byte for byte and at any length.

## [0.16.1] - 2026-11-16

### Changed
- Session cards on phones and narrow windows are more compact: the status and PR links
  share a row, the token line sits under them, and the agent and model labels stack
  neatly on the right.

## [0.16.0] - 2026-11-15

### Added
- A Session's card shows the tokens it has used (Claude Code and Codex, read from the
  agent's own transcript): fresh input plus output, with cache reads in the tooltip. Set
  a token budget in the Session's sheet or with MCP `set_session_budget` and the line
  reads used of budget, with the percentage. A budget is shown, never enforced, and a
  restart keeps it. `list_sessions` reports `usage`, `budget_tokens` and
  `budget_used_percent`.

## [0.15.3] - 2026-11-15

### Fixed
- Installing an npm agent (Codex, Command Code, Gemini CLI, Kimi Code, Qwen Code,
  opencode) no longer fails setup or an upgrade when the server's npm is broken while its
  Node.js is fine: the agent is installed under the app's Bun instead.

## [0.15.2] - 2026-11-15

### Fixed
- Codex sign-in from Settings and over MCP never showed its link and one-time code with
  current Codex releases, and failed after 30 seconds: Codex colours both values even when
  its output is a pipe, and the colour codes hid them. They are now read through the colour.

## [0.15.1] - 2026-11-15

### Changed
- The search button in the header sits under the settings button instead of beside it.

### Security
- Passkey registration, listing and removal, the Claude sign-in routes and the claude.ai
  browser routes need a browser session: a CLI token could register its own passkey and
  become a full web session, and could read the sign-in terminal's output.
- The shipped Caddy configs (setup and Docker Compose) always set `X-Real-IP` to the
  visitor's address, so a client-sent header can no longer dodge sign-in rate limits or
  lock the operator out. Existing installs pick this up when setup is run again.
- The sign-in rate limiter forgets expired entries and no longer counts successful
  sign-ins.

### Fixed
- `cs --server`, `cs handoff` and `cs term --sync` from a subdirectory replaced the server
  workspace with that folder alone, `.git` included; from a linked worktree they replaced
  the workspace's `.git` with a pointer to a local path. Uploads now start at the repo's
  top level and leave the workspace's `.git` alone in a worktree.
- Running `coding-sessions setup` again no longer moves the app back to the CLI's older
  release after the daily updater moved it forward.
- A failed or hung `zmx list` / `screen -ls` is no longer read as "no sessions", which
  archived every live session; a busy zmx daemon no longer shows a running session as
  ended.
- Chat (ACP): prompts over a few KB were dropped and reported as an ended session; an
  oversized prompt is refused with a clear message; the bridge stays up to show why an
  agent could not start; an open chat waits out "Restart with new secrets"; a new
  permission card no longer puts a button under the Space or Enter you were typing.
- Web shells end with their bridge and are cleaned up after a restart instead of running
  on unseen.
- Deleting a workspace no longer removes the agent history of another workspace whose
  name differs only by `_` and `-`.
- The daily agent update works for agents installed under Bun.
- `cs mirror` and `--attach` find screen sessions on installer and Docker servers.
- Chat and `cs live` show prompts that start with a tag (`<div> is not centered, why?`).
- The end-session sheet: a slow answer can no longer tick "Also delete the workspace
  folder" for a different session, and "End all sessions" / "Clear ended history" no
  longer show the last session's buttons.
- Markdown emphasis no longer closes inside inline code (`2*3`); the terminal opened from
  a chat links back for names with capitals; "Sign in again" in the claude.ai browser
  sheet works; pull-request lookups no longer race while typing.
- A JSON body of `null` or a malformed path returns 400 instead of 500; claude.ai chat
  deletions that ran out of attempts can be retried.

## [0.15.0] - 2026-11-12

### Added
- MCP `add_project` and `remove_project`: register a project for Chat (ACP) mode without
  the app, by cloning a repo into a new workspace or naming a folder already under
  `~/workspaces`. Other folders stay app-only. `server_status` lists a missing project
  for Chat mode with the call to make.
- Set up a fresh server from your local agent over MCP, with no SSH: `server_status`
  (readiness in one call, with what is missing and the exact next call), `setup_agents`
  (install or update agents as the service account, a job to wait on), `doctor` (non-root
  checks and repairs; root-only ones return the `sudo` command for a person) and
  `trust_workspaces`. See [MCP](docs/mcp.md#set-up-a-fresh-server-from-your-laptop).
- Installing Claude Code or Codex also installs its Chat (ACP) adapter
  (`claude-agent-acp`, `codex-acp`), under the app's own Bun: no global npm and no system
  Node.js. npm agents fall back to Bun when Node.js is missing or too old.
  `coding-sessions agents install claude-acp|codex-acp` installs an adapter alone, and the
  CLI update timer refreshes installed adapters.
- A successful Claude Code install (app, MCP) completes its first-run onboarding (theme
  picker, security notes) for the service account.
- **Settings → Server settings → Trust app workspaces** (`CS_TRUST_WORKSPACES`): an
  explicit operator choice to pre-accept Claude Code's folder trust for workspaces the app
  creates (repo, `cs sync`, handoff), never other folders. Off by default. Changing it in
  the app asks you to confirm it's you; over MCP it needs `confirm: true`, and Settings
  shows that an MCP client changed it.
- `cs live` shows Claude Code's first-run screens (theme, security notes, folder trust).

### Fixed
- A corrupt or truncated gzip handoff part is reported as `bad_gzip` (400), not `too_large`.
- A handoff compaction refused by the API (a rejected key, no credit) reports the API's
  error instead of "no compact boundary".
- `/api/secrets` with a CLI or MCP token explains that secrets are set in the app or
  through `request_secret` (`code: browser_only`), instead of a bare "Web session required".

## [0.14.0] - 2026-11-12

### Added
- `cs live [name]` (also `cs --live`) follows a session's progress in your terminal: state
  changes, the agent's messages, one line per tool call, questions with how to answer them,
  PR links, and the end. `--live` on `cs --server` and `cs handoff` follows right after the
  launch, and `--json` prints one JSON frame per line. It works for Claude Code, Codex and
  Chat (ACP) sessions, reconnects after a drop without repeating itself, and Ctrl-C detaches
  without stopping the session.
- `GET /api/sessions/:id/live`: the feed behind it, a WebSocket (or one JSON batch per
  request with `?after=`), behind the app's sign-in. Stored secret values and common token
  shapes are replaced with `[redacted]` before anything leaves the server.
- Contributor guide, Code of Conduct, issue and pull request templates, and this changelog.
- Handoff modes: `cs handoff --full|--compact|--lean` and MCP `handoff_session` `mode`
  (default `auto`: under ~50k estimated tokens full, up to ~300k compact, above that lean).
  Compact runs `/compact` on a copy on the server and resumes it; lean writes `HANDOFF.md`
  from the conversation and starts a fresh session pointed at it. Both report the
  estimated tokens before and after.
- `search_transcript` on the session communicator: a handed-off session can search its
  original conversation and get bounded snippets.

### Changed
- The handoff upload link takes gzip parts (inflated with a bound, so the size cap counts
  decompressed bytes), accepts a retried part with the same bytes, and answers
  `GET ?status`. The upload command gzips and retries parts, and waits for a compact or
  lean handoff to launch.

### Fixed
- `cs --server`, `cs term --sync` and `cs handoff` no longer delete tracked files from the
  server's checkout when `.gitignore` re-includes them with `!` (such as `.env.example`
  under `.env.*`): the upload now skips exactly what git ignores.
- Claude Code's first-run screens (theme picker, security notes, folder trust) are reported
  by `read_session` and `wait_for_session` as a question with `startup_prompt`, instead of
  `running`, and a queued launch prompt is not typed into them. The folder-trust default
  is "No, exit", which ended the session.
- A compact handoff whose `claude -p` steps cannot reach the model now falls back within
  the 15 minutes `cs handoff` and the upload command wait (each step is limited to 6
  minutes, from 10), so the client hears the fallback.
- `cs live` shows a Chat (ACP) Claude tool call by its command (`echo hello`), not the
  adapter's generic first title (`Terminal`).

## [0.13.0] - 2026-11-12

### Added
- `cs handoff` continues the Claude Code conversation you're having in a folder on the
  server, with its whole history: it rsyncs your tree as `cs --server` does, uploads the
  transcript over SSH and runs `claude --resume` there. Codex isn't supported yet.
- MCP `handoff_session` does the same for an agent without a terminal, through a one-time
  upload link (15 minutes, single use) for a branch it has pushed.

### Changed
- MCP errors carry a code (`invalid_argument`, `not_found`, `conflict`, `unavailable`,
  `failed`), a message and the next call to make.
- MCP `list_sessions` filters by agent, state or name and folder, with a limit, and shows
  each session's mode, PR links and pending requests.
- MCP `wait_for_session` says why it returned (`turn_finished`, `asking`, `ended`,
  `screen_settled`, `timeout`), and `read_session` and `wait_for_session` suggest a next step.
- MCP `launch_session` checks its arguments before launching.

## [0.12.0] - 2026-11-12

### Added
- `sudo coding-sessions doctor --fix` repairs owners and modes of everything Coding Sessions
  owns; `doctor` alone reports them. `setup`, `update` and `agents install` run the same
  repair, so `chown` and `chmod` by hand are no longer needed.
- Agent authentication lists every installed preset agent, and agents without an in-app
  sign-in get **Sign in in a terminal**.

### Fixed
- Codex is found in `~/.local/bin` when it isn't on the service's `PATH`, so its sign-in and
  launch work next to opencode.
- Docker: the container hands files left by a root `exec` back to the `cs` user on restart,
  and applies `PUID`/`PGID` to bind mounts.

## [0.11.2] - 2026-11-12

### Added
- `sudo coding-sessions reset-password` sets a new random admin password (or one read with
  `--stdin`), prints it once and signs out every browser.

## [0.11.1] - 2026-11-11

### Fixed
- Sent replies show at once in the chat of Claude Code and Codex terminal sessions.
- Slash commands show as typed instead of being dropped.
- HTML entities in agent text show as characters.

## [0.11.0] - 2026-11-09

### Added
- Secret requests: an agent that needs an API key sends you a one-time link, and you paste
  the key in the app instead of the chat.
- Connector requests for remote MCP servers that need a token or an OAuth sign-in.
- Running sessions see new keys through `CS_SECRETS_FILE`, and **Restart with new secrets**.
- `list_secrets` and `secret_status` let agents check what's stored before asking.

## [0.10.0] - 2026-11-09

### Added
- Feels like a native app when installed on iPhone or Android: swipe-to-close sheets, pull
  to refresh, a composer above the keyboard, launch images and screen transitions.
- Slash commands in Chat (ACP) from a `/` menu.
- **Open chat** from the terminal page, and passkey autofill on the sign-in screen.

### Fixed
- A white screen after coming back to the app on iPhone Safari; a failed request now shows
  **Can't reach the server** with **Try again**.

## [0.9.1] - 2026-11-08

### Changed
- PR chips on session cards use GitHub's pull-request icon for the PR's state.

## [0.9.0] - 2026-11-08

### Added
- Chat (ACP) mode for every agent: a session can start as a chat over the Agent Client
  Protocol, with streamed replies, tool calls with diffs, the agent's plan and permission
  cards. It survives restarts and resumes.
- A rebuilt chat view shared by chat sessions and terminal sessions' chat.

### Fixed
- Streamed text no longer shows twice when two polls overlap.

## [0.8.1] - 2026-11-08

### Added
- PR links on session cards, with the PR's state from GitHub.

### Fixed
- The installer retries GitHub release downloads before failing.

## [0.8.0] - 2026-11-08

### Added
- Resume sessions after a reboot or sandbox wake (`CS_RESUME_AFTER_BOOT=1`, Linux).
- Chat view for Codex and Claude Code sessions.
- Turn state for Command Code and Kimi Code.
- herdr session backend (`CS_MUX=herdr`) and a local control socket (`CS_SOCKET=1`), both
  off by default.

## [0.7.1] - 2026-11-07

### Added
- Activity signal for idle checks (`CS_ACTIVITY_PORT`) and
  `sudo coding-sessions activity [--json]`.

## [0.7.0] - 2026-11-05

### Added
- Several servers in the `cs` CLI (`cs server add|ls|use|rm`, `--server=<name>`), with
  browser sign-in instead of copying a token.

## [0.6.0] - 2026-11-05

### Added
- One-command server install for Ubuntu and Debian, ending with a one-time sign-in link.
- The `coding-sessions` admin command: `doctor`, `status`, `agents`, `update`, `uninstall`
  and more.
- Install agents from the app or with `cs install`.
- An AI install skill in the repository.

## [0.5.1] - 2026-11-04

### Fixed
- The Commands sheet no longer scrolls sideways.

## [0.5.0] - 2026-11-04

### Added
- **Settings → Server settings** for the default repository, GitHub owners, claude.ai
  sign-in email, terminal mouse, update channel and agent permissions.
- Agent presets for Gemini CLI, Kimi Code, Qwen Code and opencode.

## [0.4.1] - 2026-11-03

### Fixed
- Launch prompts sent over MCP are no longer dropped when a fresh workspace takes long to
  prepare.

## [0.4.0] - 2026-11-03

### Added
- The `cs` command-line client, and `cs mcp add` to connect Claude Code or Codex.
- Official Docker image for amd64 and arm64, with optional automatic HTTPS.

### Changed
- `CS_LISTEN_HOST` sets the listen address, and `CS_TRUSTED_PROXIES` lists proxies allowed
  to report the visitor's IP.

## [0.3.0] - 2026-11-03

### Added
- Automatic app updates with rollback (off by default).

### Fixed
- Fresh installs on Ubuntu 24.04 (systemd 254+) start.
- Removing a session's folder cleans up fully.

## [0.2.0] - 2026-11-03

### Changed
- **Breaking:** renamed to Coding Sessions. Units, paths, the `cs-<instance>` service
  account, `CS_*` settings, `cs_…` CLI tokens and the `coding-sessions` MCP name all
  changed; see the release notes for the upgrade steps.

### Added
- Shared outbound MCP connectors with per-launch grants and OAuth.
- Agents can message each other through scoped MCP inboxes.
- claude.ai browser sign-in.

[Unreleased]: https://github.com/MishukAdhikari/coding-sessions/compare/v0.22.2...HEAD
[0.22.2]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.22.2
[0.22.1]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.22.1
[0.22.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.22.0
[0.21.1]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.21.1
[0.21.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.21.0
[0.20.1]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.20.1
[0.20.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.20.0
[0.19.2]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.19.2
[0.19.1]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.19.1
[0.19.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.19.0
[0.18.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.18.0
[0.17.1]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.17.1
[0.17.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.17.0
[0.16.2]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.16.2
[0.16.1]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.16.1
[0.16.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.16.0
[0.15.3]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.15.3
[0.15.2]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.15.2
[0.15.1]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.15.1
[0.15.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.15.0
[0.14.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.14.0
[0.13.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.13.0
[0.12.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.12.0
[0.11.2]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.11.2
[0.11.1]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.11.1
[0.11.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.11.0
[0.10.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.10.0
[0.9.1]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.9.1
[0.9.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.9.0
[0.8.1]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.8.1
[0.8.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.8.0
[0.7.1]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.7.1
[0.7.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.7.0
[0.6.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.6.0
[0.5.1]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.5.1
[0.5.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.5.0
[0.4.1]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.4.1
[0.4.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.4.0
[0.3.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.3.0
[0.2.0]: https://github.com/MishukAdhikari/coding-sessions/releases/tag/v0.2.0
