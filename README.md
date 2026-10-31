# Coding Sessions

**v0.1.3 preview (prerelease).** See [validation coverage and remaining checks](deploy/VALIDATION.md). Full systemd lifecycle, provider OAuth, and provider sandbox compatibility are not yet verified across the supported Ubuntu matrix.

A self-hosted control panel for Claude Code, Codex, Command Code, and other CLI agents. Start sessions from your phone, reconnect to their terminals, inspect activity, and resume supported conversations. An authenticated MCP endpoint lets compatible clients manage the same sessions.

Built with Bun, SQLite, and plain browser JavaScript. Licensed under [MIT](LICENSE).

## Trust model

This is a tool for **one trusted operator per Unix account and instance**, not a multi-tenant SaaS. Browser and MCP access can start programs with that account's permissions. Sessions under the same account can access its workspaces and credentials; project boundaries are not security boundaries.

The Ubuntu installer creates a dedicated non-root account without sudo access. New installations retain provider trust/approval prompts and filter inherited environment variables. These controls reduce exposure but do not isolate hostile workloads. Use a dedicated machine or VM for work you do not trust. Read [Security](docs/security.md) before exposing an instance.

## Ubuntu quickstart

Prerequisites:

- Ubuntu Server 24.04 or 26.04, amd64 or arm64, with systemd and administrative access.
- A hostname whose DNS points to the server, and HTTPS termination with WebSocket support.
- A reviewed checkout and a reviewed Linux Bun binary. Alternatively, supply an exact Bun release and its independently verified archive SHA-256.
- Provider CLIs and accounts, installed separately under the dedicated service account; the helper requires Node.js 22+ and npm for Codex and Command Code.

Clone and review the source, then substitute your hostname and Bun path:

```bash
git clone https://github.com/MishukAdhikari/coding-sessions.git
cd coding-sessions
sudo ./deploy/install-ubuntu \
  --instance personal \
  --origin https://sessions.example.com \
  --port 9121 \
  --bun /absolute/path/to/reviewed/bun \
  --install-nginx
sudo certbot --nginx -d sessions.example.com
```

`--check` validates inputs and reports target paths without installing. `--no-start` stages installation without starting services. `--install-nginx` is optional if you already manage a reverse proxy. Do not expose the application port directly; complete HTTPS before browser use. See [Installer operations](deploy/README.md) for all flags, provider installation, and host compatibility checks.

For `personal`, the service is `xcloud-sessions@personal`, the account is `xcs-personal`, and its home is `/var/lib/xcloud-sessions/personal`. Configuration lives in `/etc/xcloud-sessions/personal.env`; application releases live under `/opt/xcloud-sessions/personal`.

## First sign-in

Retrieve the installer-generated administrator password in your private SSH terminal:

```bash
sudo cat /etc/xcloud-sessions/credentials/personal/admin-password
```

Do not paste it into issues, chats, or logs. Open your HTTPS origin, sign in, and register a passkey. The password file initializes the password hash; editing it later is not an automatic password-reset mechanism.

Install and authenticate agents as `xcs-personal`, never as root. Once Node.js 22+ and npm are available, the optional helper installs selected CLIs:

```bash
sudo -u xcs-personal -H /opt/xcloud-sessions/personal/current/deploy/install-provider-clis codex claude command-code
```

Use **Agent authentication** in the app for supported sign-in/account actions. Account changes apply to the whole instance. Existing logins may have an unknown login date, and providers do not all expose email addresses.

Fresh Codex workspaces may pause at folder trust. The app shows **Folder trust required** while startup is pending; open the terminal to review the folder yourself. It does not accept trust on your behalf or report readiness before the managed hook arrives.

Managed Codex sessions additionally need the root-owned hook policy installed with `--codex-hooks`. Existing Codex policies are not silently replaced. Review the installer guide before enabling this host-wide policy.

For MCP, open **Connect Claude or Codex** and follow the connection instructions. Approve only connections you initiated. See [MCP setup](docs/mcp.md) for OAuth and reverse-proxy details.

## Configuration and secrets

Use [.env.example](.env.example) for non-secret configuration. Keep secrets out of the checkout.

| Material | Storage |
|---|---|
| Origin, port, paths, permission mode | Instance `.env` / `EnvironmentFile`; no secret values |
| Initial admin password and token encryption key | Root-private files delivered through systemd `LoadCredential` |
| Admin password | Password hash in SQLite; bootstrap file remains sensitive |
| Custom-command and app-managed Command Code API tokens | AES-256-GCM ciphertext in SQLite when the encryption key is configured |
| Native provider and GitHub logins | Provider-managed files in the service account's home |
| Browser session, CLI bearer, OAuth code/access/refresh tokens | Hashes in SQLite |

Legacy instances without an encryption key retain plaintext app-token compatibility. Adding a key encrypts subsequent token writes; it does not automatically rewrite old rows or backups. The application decrypts tokens for provider delivery, so encryption at rest does not hide them from the running account. Details: [secret handling and recovery](docs/security.md).

## Updates and removal

Application updates are explicit: review a new checkout and rerun the installer for the same instance and settings, omitting `--install-nginx` if its site already exists. Keep backups and the previous release until health checks pass. The installer preserves managed configuration and credentials and refuses to take over unmanaged paths; a changed shared unit requires separate review.

Provider CLI updates are separate. Opt in with `--daily-updates`, or manage the daily timer as an administrator:

```bash
sudo systemctl enable --now xcloud-sessions-update@personal.timer
sudo systemctl start xcloud-sessions-update@personal.service
sudo systemctl disable --now xcloud-sessions-update@personal.timer
```

The default schedule is daily at 00:00 UTC. The UI can show update status, but new isolated installs leave privileged timer control to administrators. This timer does not update the application or operating system.

To retire an instance, first end its sessions and back up its state and credentials. Disable its update timer and application service, then remove its reverse-proxy route. There is no automatic destructive uninstall: review and remove only that instance's release, state, credential, configuration, and ownership-marker paths, and its `xcs-NAME` account. Shared template units may serve other instances. Stopping the web service alone does not guarantee detached agents have exited.

**Existing deployments:** do not point this installer at a personal service account or an unmanaged production directory. Inventory paths, credentials, approval settings, detached sessions, and backup recovery first. Explicit `unrestricted` permission mode and `inherit` environment mode exist for deliberate legacy compatibility; they are not the new-install defaults.

## Development and security reports

See [local development](docs/local-dev.md) for Bun setup, HTTPS, tests, and Linux-specific verification. Report vulnerabilities privately following [SECURITY.md](SECURITY.md).
