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
cs server add personal https://sessions.example.com --ssh you@sessions.example.com
cs doctor           # checks everything is wired up
```

`cs server add` prints a link and a short code and opens the app in your browser.
Check the code matches and press **Allow**; `cs` gets its own CLI token, listed in
**Settings → CLI access** as "cs on <your computer>". Nothing to copy. Over SSH, open
the link on any device that is signed in to the app. For scripts and CI, pass a token
minted in **Settings → CLI access** instead: `--token -` reads it from stdin.

`cs login` asks the same questions one by one, if you prefer that. `cs upgrade` pulls
the checkout to the latest; `cs --version` shows what you run.

Settings live in `~/.config/cs/config.json` (mode 600). If the server sits behind
Cloudflare Access, either add an Access service token in `cs login`, or let `cs` route
API calls over SSH to the server's localhost (`--ssh-api`).

## Several servers

`cs` keeps each server under a short name, so one laptop can drive a lab server and a
personal one:

```bash
cs server add lab https://lab.example.com
cs server add personal https://personal.example.net --ssh you@personal.example.net
cs server ls                  # * marks the default, and whether each one answers
cs server use personal        # make it the default
cs server rename lab work
cs server rm work             # then revoke its token in that app
```

Every command that talks to a server takes `--server=<name>` or `-S <name>`; without
one it uses `CS_SERVER`, then the default:

```bash
cs --server "fix the flaky test"          # default server
cs --server=lab "fix the flaky test"      # lab
cs list -S lab
CS_SERVER=lab cs list
```

`cs term` keeps `-S` as its short `--sync`, so pick its server with `--server=<name>`.
`CS_API`, `CS_TOKEN` and `CS_SSH` still work for a one-off server that is not saved;
they are ignored when you name a server.

A config from before named servers is moved over the first time `cs` runs: the server
is named after the first part of its host (`sessions` for `sessions.example.com`) and
becomes the default. The old file stays next to it as `config.json.v1.bak`.

## Commands

```text
cs --server "<prompt>"        run on the server, seeded with your working tree
cs --server --attach "..."    …then attach this terminal to it (rerun to reattach)
cs handoff [name] ["<next>"]  continue this folder's Claude Code conversation on the server
cs list [--json]              sessions running on the server
cs end <name> [-y]            end one
cs open [name]                print, open and copy its claude.ai link
cs term [name] [--sync]       interactive claude on the server that survives disconnects
cs mirror [name]              join a live session in your terminal, next to the app
cs live [name] [--json]       follow a session's progress: messages, tool calls, questions
cs ssh [name]                 shell on the server, in the session's folder
cs mcp add|status|remove      let Claude Code / Codex drive sessions over MCP
cs socket <method> [json|-]   on the server: call a tool over the local control socket (socket.md)
cs server add|ls|use|rm       the servers this machine uses
cs                            anything else goes to your local `claude`
```

`cs --server` derives the session name from your branch. On first launch the server
copies its base checkout, then `cs` uploads your local changes over `rsync`, skipping
gitignored paths. After that the server's copy is the source of truth — the work comes
back through git (`cs pull`).

## Handoff

```text
cs handoff [name] ["<next instruction>"] [--full|--compact|--lean] [--agent claude]
```

Continues the Claude Code conversation you are having in this folder on the server,
with its whole history, instead of re-explaining it in a prompt:

1. finds the newest conversation for this folder in `~/.claude/projects/<folder>/`
   and prints its id and size;
2. prepares a workspace and rsyncs your tree exactly as `cs --server` does
   (uncommitted changes and unpushed commits travel);
3. uploads the transcript over your SSH connection, never in an HTTPS request body,
   into the workspace's `.cs-handoff/` folder (`umask 077`, a 0600 file). The server
   refuses symlinks, rewrites the transcript's `cwd` fields to the workspace path, moves
   it into its own transcript folder and removes `.cs-handoff/`;
4. starts the session in the mode below, with your instruction as the first new
   message, prints the token estimate before and after, and the claude.ai link. The
   local agent can stop.

`name` defaults to the branch and must not already run or have a workspace on the
server. Transcripts can hold anything the agent printed, which is why they travel only
over SSH.

### Modes: how much history the server reads

The server's first turn reads the whole resumed conversation, and none of it is in a
prompt cache there (a cache does not carry across machines: the system prompt and tools
differ). So the lever is sending less history. `cs handoff` estimates the conversation's
size (characters / 4 over the message text a resume loads; an estimate, not a
tokenizer) and picks a mode:

| Mode | When (auto) | What the server does |
|---|---|---|
| `--full` | under ~50k tokens | `claude --resume <id>`: the whole conversation. |
| `--compact` | ~50k to ~300k | `claude -p --resume <id> --fork-session "/compact …"` on a copy, then resumes the compacted copy. The summary is told to keep goal, decisions, next steps, key files and exact names and values. |
| `--lean` | over ~300k | `claude -p --resume <id> --fork-session` writes `HANDOFF.md` (goal, decisions, done, next, key files, open questions, facts to keep) into the workspace, kept out of git via `.git/info/exclude`; then a **fresh** session starts whose first prompt points to `HANDOFF.md` and your instruction. |

`--mode=auto|full|compact|lean` is the same. It prints, for example:

```text
Resuming would read ~180k tokens (estimate) → compact handoff (auto).
Compacting a copy on the server, then resuming (a minute or two)… started.
Resuming ~180k tokens; compacted to ~22k tokens (estimates).
```

In every mode the full transcript is uploaded and kept on the server, and the session
can grep it with the `search_transcript` tool of its `coding_sessions_communicator` MCP
(bounded snippets: at most 20 results, about 600 characters each, 12 KB in all). The
lean first prompt says so. If compaction fails (for example a conversation with too
few messages), the server falls back to lean and says so; if writing `HANDOFF.md`
fails, it resumes the full conversation. Compact and lean run `claude -p` on the server
first, so they take a minute or two; `cs handoff` waits for the launch.

On a server in standard permission mode, a fresh workspace still shows Claude Code's
folder-trust prompt on the first interactive start, as any Synced Launch does: answer
it in the app (or with `read_session` and `press_keys`).

Codex (`--agent codex`) is refused for now: the server's Synced Launch runs Claude
Code only, and resuming a Codex rollout from another folder is not verified yet.

An agent without a terminal can do the same through MCP: `handoff_session` (see
[MCP](mcp.md#handoff)).

## Live

```text
cs live [name] [--json]
cs --live [name]
cs --server --live "<prompt>"
cs handoff --live ["<next>"]
```

Follows what a session is doing, from your terminal, without attaching to it:

```text
● live: fix-login (claude)  Ctrl-C detaches; the session keeps running
◇ running
› fix the flaky login test
◆ The test races the session cookie. Making the wait explicit.
  ⚙ Read server/auth.test.ts
  ⚙ Bash bun test server/auth.test.ts
? the agent is waiting for your answer
  → answer in the app, or in this terminal: cs mirror fix-login
⇢ PR you/app#42  https://github.com/you/app/pull/42
◇ finished
```

- `name` defaults to this branch's session, or the only one running. On attach you see the
  last 20 entries, then everything new as it happens.
- One line per tool call (`Read path`, `Bash command`, an Edit with its file and `+/-` lines
  in Chat mode); long messages are cut at 12 lines. Questions and permission requests are
  highlighted with their options and where to answer them; `cs live` itself only watches.
- Ctrl-C detaches; the session keeps running. `cs live` exits on its own when the session
  ends (exit 1 if it failed).
- `--json` prints one JSON frame per line (`hello`, `state`, `message`, `tool`, `ask`, `pr`,
  `notice`, `end`), for scripts.
- `--live` on `cs --server` or `cs handoff` launches as usual, then follows the session.

It works for Claude Code, Codex and Chat (ACP) sessions; other agents show their state changes
and PR links only. The server reads the same transcript or chat log as the app's chat view and
pushes it over a WebSocket at `GET /api/sessions/<id>/live`, signed in with your CLI token
(a browser's cookie works too, from the app's own origin only). After a drop `cs` reconnects
from where it stopped. With `--ssh-api` it polls the same endpoint over SSH every 2 seconds
instead. Stored secret values and common token shapes (`sk-`, `ghp_`, `github_pat_`, `xox…-`,
AWS keys, `Bearer …`) are replaced with `[redacted]` on the server before they reach you.

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

Each server gets its own MCP connection: `coding-sessions` for the default server and
`coding-sessions-<name>` for the others. `cs mcp add --server=lab` adds lab's, `cs mcp add
--all` adds every saved server, and `cs mcp status` shows them all. With `--token`, Codex
reads a non-default server's token from `$CS_TOKEN_<NAME>`, such as `$CS_TOKEN_LAB`.
