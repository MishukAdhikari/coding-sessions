# Local development

Use Bun for the server and tests. Ubuntu is the deployment target; macOS is useful for browser/API work, but does not validate systemd, `/proc`, or managed Codex policy behavior.

## Start a development instance

```bash
bun install --frozen-lockfile
ORIGIN=http://localhost:9121 RP_ID=localhost COOKIE_SECURE=0 bun run dev
```

Use this loopback-only mode for development. The default state directory is `data/` beside the application; it is created with private permissions. Set `XCS_DATA_DIR` to an absolute path when you need separate state. The first run without a supplied password creates `data/bootstrap-password`; read it locally, not from logs:

```bash
cat data/bootstrap-password
```

If an existing password hash is present, startup does not reset it. Do not delete authentication rows as a casual development reset on shared state. Use a new private `XCS_DATA_DIR` for a clean disposable instance.

## HTTPS and passkeys

For testing deployment-like authentication, configure a local HTTPS reverse proxy with WebSocket support, then set `ORIGIN` and `RP_ID` to its hostname. For example, a Herd installation can proxy `xcloud-sessions.test` to `http://127.0.0.1:9121`:

```bash
herd proxy xcloud-sessions http://127.0.0.1:9121 --secure
```

Local `.env` configuration:

```dotenv
ORIGIN=https://xcloud-sessions.test
RP_ID=xcloud-sessions.test
PORT=9121
```

Leave secure cookies enabled for HTTPS. Passkeys are bound to the relying-party ID; changing it can prevent previously registered passkeys from working. Keep credential values out of `.env`; optional protected file paths are documented in [the example](../.env.example).

## Sessions and providers

Install `ttyd` and GNU screen before starting the server; executable locations can be resolved at startup. On macOS, `brew install ttyd screen` supplies these dependencies. Authenticate provider CLIs under the same account that runs the app, using disposable credentials when testing destructive authentication actions.

Workspaces live under the running account's `~/workspaces`. There is no built-in personal project or default GitHub repository: add projects yourself, or configure `XCS_DEFAULT_REPO=owner/repository`. Standard launches retain trust and approval prompts. `XCS_CHILD_ENV=filtered` forwards a small operational environment, not every variable in your shell. Use explicit provider credentials rather than turning on `inherit` to hide a test failure.

Managed Codex sessions require the installed root-owned requirements, hook sources, and interpreter documented in [installer operations](../deploy/README.md). Do not weaken those checks for macOS development. Use reducer/preflight fixtures locally and perform managed launch/resume checks in an isolated Ubuntu VM.

## Verification

```bash
bun test
bunx tsc --noEmit
```

For focused secret-storage work:

```bash
bun test server/secrets.test.ts server/commands.test.ts server/command-code.test.ts
```

Mock external CLI boundaries when testing login/logout, token storage, update controls, and failure handling. Never use real account logout or a production workspace as a test fixture. Exercise phone and desktop browser layouts for UI changes, including keyboard focus, dialogs, and WebSocket terminal reconnect.

Linux release checks should cover provider launch, trust prompts, managed hooks, exact resume, attach/end/archive, application restart with detached sessions, and update timer behavior. macOS process ancestry and terminal behavior differ, so a local pass is not a Linux lifecycle pass.

## Deployment

There is no repository-wide automatic deployment implied by pushing a branch. Follow [installer operations](../deploy/README.md) for a reviewed release on a dedicated Ubuntu instance. Existing installations may have their own deployment automation; inventory it before changing anything. Keep provider approvals, credentials, workspaces, and detached sessions intact when upgrading a live instance.
