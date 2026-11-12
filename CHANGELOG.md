# Changelog

What changed in each release, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions are the `vX.Y.Z` tags
on [GitHub Releases](https://github.com/MishukAdhikari/coding-sessions/releases), where each
release also lists how it was validated.

## [Unreleased]

### Added
- Contributor guide, Code of Conduct, issue and pull request templates, and this changelog.

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

[Unreleased]: https://github.com/MishukAdhikari/coding-sessions/compare/v0.13.0...HEAD
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
