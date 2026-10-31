# MCP connector

The app serves an MCP server at `https://sessions.example.com/mcp`, so the
Claude app (desktop, web, phone), Claude Code and Codex can drive Sessions as tools:
list them, Launch one, send it a message, wait for its turn to finish, read its
screen, answer its menus, Resume and End.

Transport is Streamable HTTP, stateless, JSON responses only (no server-sent
stream; `GET /mcp` is 405). Auth is OAuth 2.1 with dynamic client registration and
PKCE; an `xcm_` CLI token also works as a fixed bearer header.

## Tools

| Tool | What it does |
| --- | --- |
| `list_sessions` | Live Sessions with agent, state and folder, plus Host Pressure. `include_ended` adds the Archive. |
| `read_session` | The bottom of a Session's terminal as plain text, and its state. |
| `send_message` | Types a message and presses Enter. Multi-line text goes in as one bracketed paste. |
| `press_keys` | Keys in order (`enter`, `escape`, `up`, `down`, `shift+tab`, `ctrl+c`, a digit…), for menus and questions. |
| `wait_for_session` | Waits (≤ 90 s per call) until the agent stops working, asks, or the Session ends; returns the screen. |
| `list_projects` | Project allowlist (by id) and the agents this server runs. |
| `list_repos` | Repos a Fresh Launch can clone. |
| `launch_session` | Launch in a Project or a fresh Workspace; with `prompt`, waits for the agent to be ready and sends it. |
| `resume_session` | Reopen an archived conversation. |
| `end_session` | End a Session (archives it); `delete_workspace` also removes its folder. |

States: `starting`, `working`, `asking` (blocked on a question), `waiting`
(finished its turn), `running` (alive, no turn state — Command Code and registered
Commands, or Codex with stale telemetry), `ended`. Without turn state,
`wait_for_session` returns once the screen has stopped changing for ~4 s.

Only Managed Sessions (`m:cs-*`) can be read or typed into; an External Session has
no holder to reach.

## Connect

The quickest way is the web app: Menu → **Connect Claude or Codex…** shows the URL
and the exact command for each client with a Copy button, filled in for this host.
Generating a token under **CLI & MCP access** also shows the token versions of the
Claude Code and Codex commands.

### Claude app (desktop, web, phone)

Settings → Connectors → **Add custom connector** → URL
`https://sessions.example.com/mcp`. Leave the OAuth client fields empty — Claude
registers itself. A browser opens on the app's sign-in page: unlock with the
passkey (or password), then **Allow**. Connectors added on claude.ai sync to the
desktop and phone apps.

### Claude Code

```bash
claude mcp add --transport http -s user xcloud-sessions https://sessions.example.com/mcp
```

Then `/mcp` in a Claude Code session → `xcloud-sessions` → **Authenticate**.

Without a browser (a server, CI): use a CLI token from the menu (**CLI & MCP access**)
as a header instead:

```bash
claude mcp add --transport http -s user xcloud-sessions https://sessions.example.com/mcp \
  --header "Authorization: Bearer xcm_…"
```

### Codex

```bash
codex mcp add xcloud-sessions --url https://sessions.example.com/mcp
```

`add` notices the server wants OAuth and starts the sign-in; `codex mcp login
xcloud-sessions` repeats it. Without a browser:

```bash
export XCS_TOKEN=xcm_…
codex mcp add xcloud-sessions --url https://sessions.example.com/mcp --bearer-token-env-var XCS_TOKEN
```

## Auth details

- `/.well-known/oauth-protected-resource[/mcp]` and
  `/.well-known/oauth-authorization-server[/mcp]` describe the server; `/mcp` answers
  401 with `WWW-Authenticate: Bearer resource_metadata=…` until a token is sent.
- `POST /oauth/register` accepts only redirect URIs on `claude.ai` / `claude.com`
  (https) or loopback (`http://localhost`, `127.0.0.1`, `[::1]`, any port).
  `MCP_REDIRECT_HOSTS=host1,host2` in the unit adds more https hosts.
- `/oauth/authorize` is the one human step and needs the web app's own sign-in.
  The `xs_auth` cookie is SameSite=Strict, so arriving from claude.ai the page first
  shows sign-in; `public/oauth.js` notices a live session through `/api/me` and
  reloads once into the consent page.
- Codes: single use, 5 minutes, PKCE S256 required. Access tokens: 1 hour.
  Refresh tokens: 30 days, rotated on each use. All stored as SHA-256 hashes.
- The browser cookie is never accepted at `/mcp`; OAuth tokens are accepted only
  at `/mcp`, nowhere else in `/api/`.
- **CLI & MCP access** in the menu lists connected apps; **Disconnect** deletes the
  client and every token it holds.

## Cloudflare Access

The whole host sits behind Cloudflare Access, and Claude's servers (and a CLI's
token refresh) can't pass an Access login. These paths need a **Bypass** policy —
the app's own OAuth guards them instead:

- `sessions.example.com/mcp`
- `sessions.example.com/.well-known/oauth-protected-resource`
- `sessions.example.com/.well-known/oauth-authorization-server`
- `sessions.example.com/oauth/register`
- `sessions.example.com/oauth/token`

`/oauth/authorize` stays behind Access: it opens in your own browser, which can
pass it. In Zero Trust → Access → Applications, add a self-hosted application
covering those paths with one policy, action **Bypass**, include **Everyone**.
A more specific path wins over the host-wide application.

Cloudflare cuts a response off at 100 s, which is why `wait_for_session` caps at 90 s
and `launch_session` waits at most 60 s for the agent before sending its prompt.

### Agent accounts

`agent_accounts` reads Codex, Claude, and Command Code installation and sign-in
state, available email, plan, organization, authentication method, and
`loggedInSince`. Missing metadata is `null`; existing logins have an unknown
login time until a new login and stable account identity are confirmed through
this app. Providers without a stable identity keep an unknown time. Status reads do not
reset the timestamp. A different reported identity invalidates the old time.
Command Code may report authentication without an email or account identity.

`agent_auth` accepts `agent` (`codex`, `claude`, or `command-code`) and `action`
(`status`, `login`, `switch`, `logout`, `cancel`, or `submit_code`). Use account
mutations only when the owner requests them: they affect the shared server
account used by sessions. `switch` verifies sign-out before starting replacement
sign-in. Failed sign-out or Claude callback submission returns a tool error.
`submit_code` accepts a Claude OAuth callback `code`, never an API key.
Command Code sign-in returns a browser continuation path; enter its key only in
the authenticated browser. Account responses never include stored credentials
or terminal output. Unknown provider status is distinct from signed out.
