# Install on a server

One command sets up everything Coding Sessions needs on a fresh server, including what coding agents need to run smoothly. Run it again any time to repair or change the setup.

## Before you start

- **A server:**
  - Ubuntu 22.04, 24.04 or 26.04, or Debian 12 or 13, including Raspberry Pi OS 64-bit.
  - x86_64 or arm64, running systemd.
  - 2 GB of RAM or more; setup offers swap below 4 GB.
  - 8 GB of free disk or more.
- **A domain** whose DNS A record points at the server, e.g. `sessions.example.com`. HTTPS and passkeys need one.
- **Ports 80 and 443** reachable from the internet. They're used for the HTTPS certificate and the site.

| Platform | How |
|---|---|
| Ubuntu 22.04, 24.04, 26.04; Debian 12, 13; Raspberry Pi OS 64-bit | This installer |
| RHEL, Rocky, Alma, Fedora, Amazon Linux 2023, Arch, Alpine | [Docker](docker.md). Their packages come from extra repositories, or SELinux, OpenRC, musl, or no Playwright support gets in the way, so there's no native installer yet |
| Windows (WSL2), macOS, 32-bit Raspberry Pi OS | Not as a server: WSL2 doesn't keep services running, macOS has no systemd, and Bun has no 32-bit ARM build. Use a Linux VPS |

Run the installer as root: with `sudo`, or as `root` on Debian systems installed without sudo.

## Install

```bash
curl -fsSLO https://github.com/MishukAdhikari/coding-sessions/releases/latest/download/install.sh
curl -fsSLO https://github.com/MishukAdhikari/coding-sessions/releases/latest/download/install.sh.sha256
sha256sum -c install.sh.sha256      # the download is intact
less install.sh                     # optional: read what it does
sudo bash install.sh
```

`install.sh` fetches the release it was published with, pinned to that release's exact commit. It then installs the `coding-sessions` command and starts its guided setup.

Setup asks only for:
1. the domain;
2. an email for the HTTPS certificate;
3. which coding agents to install, if any;
4. whether to install the Playwright browser;
5. whether to turn on daily updates;
6. on small servers, whether to add swap.

Then it:
1. checks the server, the ports and the DNS record;
2. shows its full plan and asks before changing anything;
3. installs, prints a **one-time sign-in link**, and stops.

Open the link, press **Sign in with this link**, and add a passkey; that's the whole sign-in. The link works once and expires after 30 minutes. It's only used when you press the button, so a link scanner that opens it can't use it up.

To skip the questions, pass everything as options:

```bash
sudo bash install.sh --domain sessions.example.com --email you@example.com \
  --agents claude,gemini --browser --updates --yes
```

Add `--dry-run` to see the plan without changing anything.

## What setup does

| | |
|---|---|
| System packages | git, screen, rsync, build tools, ripgrep, jq, Python; the GitHub CLI from GitHub's own signed repository (some distribution packages no longer work) |
| Web terminal | ttyd 1.7+: the distribution's package where it's new enough, otherwise the pinned upstream build checked against its SHA-256 |
| HTTPS | Caddy from its own signed repository, with an automatic Let's Encrypt certificate. The app itself listens only on 127.0.0.1 |
| Runtime | Bun, a pinned version checked against its SHA-256 |
| Node.js 22 | Only if you pick an agent that needs it, from NodeSource's signed repository |
| The app | A dedicated `cs-<instance>` account with no sudo, and a systemd service |
| Agents | The ones you pick, installed as that account, never as root |
| Browser | Playwright's Chromium and its system libraries, if you choose it |
| Tuning | Higher file-watch and open-file limits; 2 GB swap if you agree; ports 80/443 opened in ufw if ufw is already on |
| Updates | Daily app and agent updates, if you choose them. A new app version is kept only if it starts cleanly |

Setup never changes SSH settings or existing firewall rules. An existing Caddy configuration with other sites is kept; setup only adds one import line, checks the result, and puts everything back if Caddy rejects it. Kernel limits are only ever raised. To check that the domain points at the server, it asks `api.ipify.org` for the server's public IP.

## Running the server

The `coding-sessions` command manages everything afterwards:

```text
sudo coding-sessions setup               re-run setup: repair, or change agents, browser, updates
sudo coding-sessions doctor              check everything; each problem comes with its fix
sudo coding-sessions status              URL, versions, services, updates
sudo coding-sessions activity [--json]   when it was last in use (needs CS_ACTIVITY_PORT)
sudo coding-sessions agents              installed agents and versions
sudo coding-sessions agents install gemini kimi
sudo coding-sessions agents update
sudo coding-sessions browser install     add Playwright Chromium later
sudo coding-sessions setup-link          a new one-time sign-in link
sudo coding-sessions update [--agents]   update the CLI and the app (and agents)
sudo coding-sessions logs [-f]
sudo coding-sessions restart             agent sessions keep running
sudo coding-sessions uninstall [--purge] stops everything; keeps your data unless --purge
```

Agents can also be installed from the app: **Settings → Agent authentication**.

## Troubleshooting

- **"doesn't resolve" or "points at … but this server is …":** fix the domain's A record, wait a few minutes, and run setup again. If a proxy such as Cloudflare sits in front of the domain, add `--skip-dns-check`.
- **"port 80/443 is used by …":** another web server is running. Stop it, or put Coding Sessions behind it yourself; [deploy/README.md](../deploy/README.md) covers the manual install.
- **The HTTPS site doesn't come up:** run `sudo coding-sessions doctor`. Then `journalctl -u caddy -n 50` shows why the certificate wasn't issued.
- **Lost sign-in:** run `sudo coding-sessions setup-link`.
- **"systemd on this host cannot pass credentials":** some container-based VPSes (LXC) can't hand services their secrets the usual way. The service then reads owner-only copies in its own home, as the Docker image does. Setup checks this every run and switches back when systemd can.
- **Changing the domain:** passkeys are tied to the domain, so a re-run refuses it. Install a second instance with `--instance NAME --port PORT` for the new domain.

## Manual install

To read the whole source first, or choose every path yourself, clone the repository and use `deploy/install-ubuntu` directly; see [deploy/README.md](../deploy/README.md). The `coding-sessions` CLI uses the same installer underneath.

## Ask an AI agent to do it

The repository includes an install skill. Open the repository in Claude Code, Codex or another agent and ask it to "install Coding Sessions on my server". It reads these docs, asks you the questions above one round at a time with recommended answers, and only runs anything once you say yes.
