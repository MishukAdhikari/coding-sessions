# Ubuntu installer operations

`install-ubuntu` accepts a reviewed local checkout. It supports Ubuntu 24.04 and 26.04 on amd64/arm64, creates an isolated account, copies root-owned application code, and installs systemd templates. It does not authenticate providers, import credentials, grant sudo, or join Docker groups.

## Install

From the reviewed checkout, on Ubuntu amd64:

```sh
sudo ./deploy/install-ubuntu \
  --instance personal \
  --origin https://sessions.example.com \
  --port 9121 \
  --bun-version 1.3.14 \
  --bun-sha256 951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
```

For arm64 use `a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b`. These are the official release API's SHA-256 archive digests for [Bun 1.3.14](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14), checked on 2026-10-31. The installer verifies the archive before execution. Alternatively supply `--bun /absolute/path/to/reviewed/linux/bun`. Choose a separately verified newer version/digest deliberately; there is no unpinned default download.

`--check` validates arguments and prints paths without changing the host. `--no-start` prepares an image without requiring a running systemd manager. The installer needs root only for provisioning; runtime uses `xcs-personal`.

Optional flags:

- `--daily-updates`: enable the installed-provider update timer at 00:00 UTC. Pausing/resuming remains an administrator operation.
- `--codex-hooks`: provision the fixed root-owned managed-hook files. Existing different `/etc/codex/requirements.toml` causes a refusal; merge administrator policy separately before retrying. No approval or project-trust policy is changed.
- `--install-nginx`: install a new per-instance HTTP proxy site. Existing site files are refused rather than overwritten. Complete TLS with `sudo certbot --nginx -d sessions.example.com` before browser use. Use an existing HTTPS proxy instead when preferred.
- `--source /path/to/checkout`: use a different reviewed source checkout.

The app binds loopback. A proxy must forward WebSocket Upgrade/Connection headers, preserve Host, and set X-Real-IP from the actual connection, not a caller-provided forwarding header. TLS, a matching origin and RP_ID are required for remote passkeys and secure cookies. The nginx template does not change unrelated sites or a global nginx configuration. It turns off access and error logging for exactly `/oauth/connectors/callback`, whose query string carries one-time OAuth codes (the trade-off: proxy errors for that one path are not logged); do the same for access, error and trace logs in any other proxy or log pipeline. External MCP sign-in derives its redirect URI from `ORIGIN`, so `ORIGIN` must be the public HTTPS address providers redirect to.

## Files and credentials

| Path | Owner and purpose |
|---|---|
| `/opt/xcloud-sessions/personal/releases/*`, `current` | Root-owned release source and Bun; instance cannot rewrite its server code. |
| `/var/lib/xcloud-sessions/personal` | Private mode0700 home owned by `xcs-personal`, with data, runtime sockets, workspaces and provider state. |
| `/etc/xcloud-sessions/personal.env` | Root0600 nonsecret instance settings. |
| `/etc/xcloud-sessions/credentials/personal/admin-password` | Root0600 generated bootstrap password, delivered with systemd LoadCredential. |
| `/etc/xcloud-sessions/credentials/personal/token-encryption-key` | Root0600 base64 32-byte encryption key, delivered with systemd LoadCredential. Preserve this alongside database backups. |

The administrator can read the bootstrap password privately with `sudo cat /etc/xcloud-sessions/credentials/personal/admin-password`. Do not paste it into logs or support reports. No credential contents are printed by the installer. The service unit supplies these files through `CREDENTIALS_DIRECTORY`; it does not place them in the environment file.

Rerunning the installer preserves existing credentials, state, screen configuration and environment settings. It refuses unmanaged accounts or paths, changed origin/port, extra service-account groups, instance overrides and differing shared unit templates. Such conflicts need an administrator review rather than silent takeover. Each run stages a new release and switches `current`; old releases remain for rollback.

## Provider setup

Install a supported Node.js release **22 or newer** and npm on the service PATH before selecting npm providers. Ubuntu 24.04's default Node 18 package is insufficient for Command Code. [Node downloads and signed-checksum instructions](https://nodejs.org/en/download)

Then install selected CLIs as the instance user:

```sh
sudo -u xcs-personal -H /opt/xcloud-sessions/personal/current/deploy/install-provider-clis codex claude command-code
```

The helper uses the providers' official npm/native installation methods and intentionally selects their latest releases. Supply only desired provider names. Authentication is a separate operator step, as this same account, through the app or the provider CLI. Never run provider login as root. The account has no passwordless sudo and no Docker group.

`screen` is installed even if another multiplexer is later selected, because Claude's CLI sign-in flow uses it. `SCREENDIR` points to the private instance runtime directory; an administrator attaching manually must use that same directory. Optional claude.ai browser automation additionally needs the repository's matching Playwright Chromium, OS browser libraries, Xvfb and xauth; it is not installed or configured by this baseline installer.

## Update and rollback

Run the installer against a newly reviewed checkout with the same instance, origin and port. Dependencies use the committed Bun lockfile with lifecycle scripts disabled. If Codex hook sources changed, review and repeat `--codex-hooks`; this replaces the fixed global hook copies, so coordinate instances that share that machine.

The app unit uses `KillMode=process` to preserve agents during a web-service restart. This deliberately leaves descendant processes alive when stopping the web service; it is not a full instance shutdown, and reboot does not preserve live agent processes. Stop sessions separately before maintenance that requires an empty instance. No memory-execution hardening that would disable Bun's JIT is enabled.

To roll back, as an administrator select a previously retained release as `current`, then restart `xcloud-sessions@personal.service`. Preserve the data directory and encryption key. Check schema compatibility before rolling back application versions; the installer does not roll back database migrations.

Daily CLI updates only touch installed user-prefix CLIs, keep status under the instance home, and never update zmx or the root-owned hook interpreter. UI status remains available, but controls are disabled for this administrator-managed deployment:

```sh
sudo systemctl enable --now xcloud-sessions-update@personal.timer
sudo systemctl disable --now xcloud-sessions-update@personal.timer
sudo systemctl start xcloud-sessions-update@personal.service
```

There is no destructive uninstall command. Disabling the service/timer leaves credentials, data and workspaces intact; remove those only after a separate backup and explicit operator decision.

## Validation

Local argument/updater tests: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/tests -v`. Syntax: `bash -n deploy/install-ubuntu deploy/install-provider-clis deploy/update-coding-clis`.

A plain Ubuntu container with `--no-start` can validate packages, rendered units, permissions and HTTP startup, but does not prove systemd runtime credential delivery, timer behavior or restart survival. Full acceptance requires an isolated systemd Ubuntu guest. Do not reuse production credentials, provider profiles or host home mounts in that guest.
