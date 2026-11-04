# Running with Docker

The official image runs Coding Sessions as an unprivileged `cs` account with the app code
read-only. Everything that changes — the database, workspaces, agent CLIs and their
logins — lives in one volume mounted at `/home/cs`.

Images: `ghcr.io/mishukadhikari/coding-sessions`, tagged `latest` and with each release
(`0.3.0`, `0.3`), for amd64 and arm64.

## Quick start

You need Docker with Compose v2 and a hostname that points at the machine.

```bash
git clone https://github.com/MishukAdhikari/coding-sessions.git
cd coding-sessions
echo "CS_HOSTNAME=sessions.example.com" > .env
docker compose --profile https up -d
docker compose exec app cat /home/cs/data/bootstrap-password
```

Open `https://sessions.example.com` and sign in with that password, then add a passkey.
The `https` profile starts [Caddy](https://caddyserver.com/), which gets and renews the
certificate on its own (ports 80 and 443 must reach the machine). Passkeys only work over
HTTPS, so do not skip it.

**Already have a reverse proxy** (nginx, Traefik, Cloudflare Tunnel)? Leave the profile out:

```bash
docker compose up -d     # app only, on 127.0.0.1:9121
```

Point the proxy at `http://127.0.0.1:9121`, pass WebSocket upgrades through, and set
`X-Forwarded-For`. Use the same hostname as `CS_HOSTNAME`.

## Install the agents

Agent CLIs install into the volume, as the `cs` account, so they survive restarts and
image updates:

```bash
docker compose exec app install-provider-clis claude codex command-code
docker compose exec -it app claude      # sign in once; same for codex
```

Or sign in from the app: **Settings → Agent authentication**.

Agent presets install the same way (`install-provider-clis gemini kimi qwen opencode`), then add them in **Settings → Commands**. See [agents](agents.md).

## Update

```bash
docker compose pull && docker compose up -d
```

Pin a release with `CS_VERSION=0.3.0` in `.env`. Restarting the container ends running
agent sessions — conversations stay and can be resumed from the app. The in-app
**App updates** switch is for servers installed with `deploy/install-ubuntu`; in Docker it
shows "Not set up", because the image is what you update.

## Settings

Set these under `environment:` in `docker-compose.yml`:

| Setting | Default in the image | |
| --- | --- | --- |
| `ORIGIN` | from `CS_HOSTNAME` | The `https://` address people open. Required. |
| `CS_AGENT_PERMISSIONS` | `standard` | `unrestricted` lets agents skip permission prompts. |
| `CS_DEFAULT_REPO` | — | `owner/repo` preselected when starting a session. |
| `CS_TRUSTED_PROXIES` | `172.31.250.0/24` | Proxies allowed to report the visitor's IP. Matches the compose network. |
| `CS_LISTEN_HOST` | `0.0.0.0` | Address inside the container; keep it. |

The token encryption key is created on first start in `/home/cs/data/token-encryption-key`
(mode 600). Back up the `home` volume to keep sessions, logins and that key together.

## Good to know

- **Security:** agents run as `cs` with no sudo inside the container. Anyone signed in to
  the app can run commands as that account, so treat the volume as sensitive.
- **Not included:** the optional claude.ai browser helper (deleting chats from claude.ai)
  needs a headless Chromium and is not in the image.
- **Platforms:** any Docker host on amd64 or arm64 — Linux servers, Docker Desktop on macOS
  or Windows for trying it out.
