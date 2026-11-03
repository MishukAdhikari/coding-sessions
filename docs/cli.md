# `cs` command-line client

`cs` runs agent work on your Coding Sessions server from your own machine. Hand off the
branch you are on — uncommitted work included — to a session that shows up in the app
and on your phone, then list, end, mirror or open those sessions from the terminal.

## CLI or MCP?

There are two ways in, for two kinds of callers:

| | `cs` CLI | MCP (`/mcp`) |
| --- | --- | --- |
| **For** | You, in a terminal or script | Agents: Claude Code, Codex, the Claude app |
| **Talks to** | The HTTPS API with a CLI token | The MCP endpoint, OAuth or the same token |
| **Can** | Synced Launch (uploads your working tree over SSH), attach a terminal, mirror, open links | List, launch, message, read, answer and end sessions as tools |

They stay separate on purpose: the API is shaped for people and scripts, MCP for agents.
`cs mcp add` is the bridge — it registers the server's MCP endpoint with your agents in
one command.

## Install

Needs [Bun](https://bun.sh) 1.1+, `git`, `rsync` and `ssh`. From a checkout of this repo:

```bash
git clone https://github.com/MishukAdhikari/coding-sessions.git
cd coding-sessions
bun install
bun link            # puts `cs` on your PATH
cs login            # server URL, CLI token, optional SSH host
cs doctor           # checks everything is wired up
```

Mint the token in the app under **Settings → CLI access**. `cs upgrade` pulls the
checkout to the latest; `cs --version` shows what you run.

Settings live in `~/.config/cs/config.json` (mode 600). `CS_API`, `CS_TOKEN` and
`CS_SSH` override them. If the server sits behind Cloudflare Access, either add an
Access service token in `cs login`, or let `cs` route API calls over SSH to the
server's localhost.

## Commands

```text
cs --server "<prompt>"        run on the server, seeded with your working tree
cs --server --attach "..."    …then attach this terminal to it (rerun to reattach)
cs list [--json]              sessions running on the server
cs end <name> [-y]            end one
cs open [name]                print, open and copy its claude.ai link
cs term [name] [--sync]       interactive claude on the server that survives disconnects
cs mirror [name]              join a live session in your terminal, next to the app
cs ssh [name]                 shell on the server, in the session's folder
cs mcp add|status|remove      let Claude Code / Codex drive sessions over MCP
cs                            anything else goes to your local `claude`
```

`cs --server` derives the session name from your branch. On first launch the server
copies its base checkout, then `cs` uploads your local changes over `rsync`, skipping
gitignored paths. After that the server's copy is the source of truth — the work comes
back through git (`cs pull`).

## MCP for your agents

```bash
cs mcp add claude      # Claude Code: then /mcp → coding-sessions → Authenticate
cs mcp add codex       # Codex: signs in with a browser the first time
cs mcp add --token     # both, using your CLI token instead of a browser sign-in
cs mcp status
```

With `--token`, Claude Code stores the token in its MCP settings; Codex reads it from
`$CS_TOKEN`, so export that in the shell you start Codex from. See [MCP](mcp.md) for the
tools agents get.
