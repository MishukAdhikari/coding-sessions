# Agents

Coding Sessions has built-in support for Claude Code, Codex and Command Code. Four more CLI coding agents are available as **agent presets**: Gemini CLI, Kimi Code, Qwen Code and opencode.

These are third-party tools. Each comes from its own vendor and has its own accounts, terms, pricing and data handling. Coding Sessions installs and launches them, but never signs you in. What you type in a session goes to the vendor you chose.

## Add a preset

1. Install the agent on the server, as the instance account (never root):

   ```bash
   # Ubuntu install
   sudo -u cs-personal -H /opt/coding-sessions/personal/current/deploy/install-provider-clis gemini kimi qwen opencode
   # Docker
   docker compose exec app install-provider-clis gemini kimi qwen opencode
   ```

   Or skip SSH: press **Install** next to the agent in **Settings → Agent authentication** (or **Settings → Commands**), or run `cs install gemini kimi` from your laptop. Install only the ones you want. Each comes from its official npm package, and the daily CLI update keeps the installed ones current.

2. Open **Settings → Commands** and press **Add** next to the agent. If it isn't installed yet, the row offers the install command to copy.
3. Sign in the way the agent expects (table below). For agents that read an API key, press **Add key** on the command. The key is stored encrypted and handed to the agent through its environment, never on the command line.
4. Pick the agent when you start a session.

## What each preset sets up

| | Gemini CLI | Kimi Code | Qwen Code | opencode |
|---|---|---|---|---|
| Vendor | Google | Moonshot AI | Alibaba (Qwen) | Anomaly (opencode) |
| npm package | `@google/gemini-cli` | `@moonshot-ai/kimi-code` | `@qwen-code/qwen-code` | `opencode-ai` |
| Node.js | 22+ | 22.19+ | 22+ | 22+ |
| Sign-in | `GEMINI_API_KEY` (Add key), or Gemini Code Assist | `kimi login` in the server terminal | `OPENAI_API_KEY` for an OpenAI-compatible endpoint (Add key), or `/auth` in the agent | `opencode auth login` in the server terminal |
| Coding Sessions MCP | entry in `~/.gemini/settings.json` | entry in `~/.kimi-code/mcp.json` | `--mcp-config` at launch | `OPENCODE_CONFIG_CONTENT` at launch |
| Unrestricted mode adds | `--approval-mode=yolo --skip-trust` | `--auto` | `--approval-mode yolo` | `--auto` |
| License | Apache-2.0 | MIT | Apache-2.0 | MIT |
| Upstream | [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) | [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) | [anomalyco/opencode](https://github.com/anomalyco/opencode) |

**MCP:** every preset session gets the same built-in Coding Sessions MCP server as Claude Code, Codex and Command Code, so it can find other sessions and message them. External MCP connectors reach preset sessions when you tick **Agent presets** on the connector. Each launch's token travels in the session's environment, never in a file.

- **Gemini CLI and Kimi Code** have no per-launch MCP option, so the app adds one entry, marked as its own, to the agent's user config. It never edits an entry you created, and it never writes into your repositories. When you run the agent yourself outside Coding Sessions, that entry starts as an MCP server with no tools, so nothing fails. If `~/.gemini/settings.json` has comments, the app won't rewrite it; the launch error shows the exact entry to add by hand.
- **Gemini CLI** starts MCP servers only in folders it trusts. In standard mode it asks you to trust the folder, and Coding Sessions' MCP connects once you do; unrestricted mode passes `--skip-trust`.

**Permission mode:** with agent permissions set to unrestricted (Settings → Server settings, or `CS_AGENT_PERMISSIONS`), presets start with the option above. In standard mode they start with the agent's own prompts.

## Turn state

The session list, the MCP tools and the activity signal show whether an agent is working, waiting for you, or finished. Each agent's state comes from a record the agent writes for itself; Coding Sessions changes nothing in the agent's own setup to get it. When the record is missing or unclear, the session shows as **Connected** instead of a guess.

| Agent | Source | Working | Waiting for you | Finished |
|---|---|---|---|---|
| Claude Code | its transcript in `~/.claude/projects/` | yes | questions and plan approval | yes |
| Codex | its lifecycle hooks, managed by Coding Sessions | yes | questions and approvals | yes |
| Command Code | its transcript in `~/.commandcode/projects/` | yes | no, shows as working | yes |
| Kimi Code | its session lock and `wire.jsonl` under `~/.kimi-code` (or `$KIMI_CODE_HOME`) | yes | approvals and questions | yes |
| Gemini CLI, Qwen Code, opencode | none yet | | | |
| Any agent in Chat (ACP) mode | the bridge's own state (`state.json`) | yes | permission requests | yes |

- **Command Code** writes a tool call only once the tool has finished, so a question or approval prompt shows as working. If a turn has written nothing for 30 minutes, the session shows as Connected, because an interrupted turn leaves no record. Through MCP, `wait_for_session` still returns when a working Command Code session's screen stops changing, so a caller can see and answer the prompt.
- **Kimi Code** creates its session when you send the first message, so a fresh Kimi session shows as Connected until then.
- **Gemini CLI** records a reply without its tool calls, so a reply followed by a running tool looks the same as a finished turn. Reading its state needs its hooks.
- **Qwen Code** writes a readable transcript, but matching it to a launch needs a session id passed at launch; not done yet.
- **opencode** keeps its state in its own database, and pending approvals only in memory. Reading it needs a plugin.

## Chat (ACP) mode

Every session starts in one of two modes, chosen per session in **Start a session** (or with `mode` on the MCP `launch_session` tool):

- **Terminal** (the default): the agent's own terminal UI, exactly as before.
- **Chat (ACP)**: the agent speaks the [Agent Client Protocol](https://agentclientprotocol.com) and the session opens as a chat. Replies stream in as formatted text, tool calls show as rows with their status and diffs, the agent's plan shows as a checklist, and a permission request shows as a card with the agent's own options (Allow once, Always allow, Reject…). **Stop** cancels the current turn.

A chat session survives app restarts and updates like a terminal session. Its holder (`cs-<name>`, under zmx, screen or herdr) runs a small bridge, `server/acp/bridge.ts`, which starts the agent, keeps the conversation in an event log on disk, and takes the chat's messages and answers on a private socket. A permission request waits in the bridge, so it is still there after a restart.

| Agent | ACP command | Installed from | Sign-in | Resume |
|---|---|---|---|---|
| Claude Code | `claude-agent-acp` | `npm install -g @agentclientprotocol/claude-agent-acp` | your existing `claude` login | session/load |
| Codex | `codex-acp` | `npm install -g @agentclientprotocol/codex-acp` | `CODEX_API_KEY` / `OPENAI_API_KEY` (Settings › Secrets), or your Codex login | session/load |
| Command Code | `command-code acp` | the installed Command Code CLI | `cmd login`, or the app-managed key | session/load |
| Gemini CLI preset | `gemini --acp` | preset install | `GEMINI_API_KEY` (Add key) | session/load |
| Qwen Code preset | `qwen --acp` | preset install | `/auth` in the agent, or an OpenAI-compatible key | session/load |
| opencode preset | `opencode acp` | preset install | `opencode auth login` | session/load |
| Kimi Code preset | `kimi acp` | preset install | `kimi login` | session/load |

The commands were checked on 2026-11-08 against each agent's source and the [ACP registry](https://github.com/agentclientprotocol/registry). The Claude Code and Codex adapters are not installed automatically; until they are, **Chat (ACP)** is shown but disabled for those agents, with the install command. Coding Sessions never downloads an adapter at launch.

- **Sign in first.** Chat mode does not run an agent's sign-in flow. An agent that isn't signed in shows the launch as failed, with the agent's own message (for example, "Gemini API key is missing or not configured").
- **Permissions.** In standard mode every request the agent makes shows as a card. With agent permissions set to unrestricted, the bridge answers each request with the agent's **Allow once** option and the chat shows it as automatic. It never picks an "always" option for you, because agents remember those beyond the session.
- **Resume.** Reopening an ended chat session asks the agent to reload the same conversation (ACP `session/load`). If the agent can't, a new conversation starts in the same folder and the chat says so.
- **The communicator.** Chat sessions get the built-in Coding Sessions MCP server (and external connectors, when enabled), passed to the agent when the session starts.
- **MCP drivers.** `send_message` sends a prompt. While the agent waits on a permission request, the session's state is `asking`, `read_session` lists the request's options, and `send_message` with one option's name answers it. `press_keys` does not apply to chat sessions.
- **Slash commands.** When the agent advertises its commands (ACP `available_commands_update`; Claude Code's list includes your skills), typing `/` at the start of a message lists them with their descriptions, filtered as you type. Pick one with a tap, the arrow keys and Enter, or Tab; it is inserted as `/name ` with the agent's hint for what to type next, and sent as an ordinary prompt. Only the agent's own commands are listed, and the list follows the agent when it changes. An agent that advertises none gets `/` as plain text. Bridges started before this version keep no list until the session is resumed. Terminal sessions don't need the menu: their chat replies go to the terminal, where the agent's own `/` commands work as typed.
- **Fresh workspaces** (a repository cloned at launch) and synced launches are terminal-only for now.
- **Not supported yet:** registered Commands that are not from a preset (their ACP command isn't known), images and file attachments in prompts, and session modes and model switching from the chat.

## Not supported yet

Presets run as Commands. Compared with Claude Code, Codex and Command Code they have:

- **No live turn state in a terminal, except Kimi Code.** Gemini CLI, Qwen Code and opencode terminal sessions show as running, not as waiting for you or finished (see Turn state above). In Chat (ACP) mode they report all three.
- **No exact resume in a terminal.** An ended terminal session can't be reopened into the same conversation from the app; the agent's own continue option still works in its terminal. Chat (ACP) sessions resume through `session/load`.
- **No sign-in panel.** Sign in through the agent itself, as listed above.

## Notes

- **Kimi:** the older `kimi-cli` is archived by Moonshot AI. The preset installs its replacement, Kimi Code.
- **Gemini CLI** is for Gemini API keys and Gemini Code Assist Standard/Enterprise. Google moved free and Google AI Pro/Ultra access to Antigravity CLI.
- **opencode:** the preset installs opencode 1.x (`opencode-ai`), whose launch options are documented. opencode 2 changes them.
