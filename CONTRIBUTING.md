# Contributing

Thanks for wanting to help. Bug reports, docs fixes and pull requests are all welcome.

Before you start, read the [trust model](README.md#trust-model): Coding Sessions is for one
trusted operator per Unix account, and changes should keep it that way. Found a security
problem? Don't open an issue; follow [SECURITY.md](SECURITY.md).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

You need [Bun](https://bun.sh) (the Docker image uses 1.3.14), git, and on macOS
`brew install ttyd screen` for the web terminal. Ubuntu is the deployment target; macOS is
fine for browser, API and CLI work.

```bash
git clone https://github.com/MishukAdhikari/coding-sessions.git
cd coding-sessions
bun install --frozen-lockfile
```

## Run it locally

```bash
ORIGIN=http://localhost:9121 RP_ID=localhost COOKIE_SECURE=0 bun run dev
cat data/bootstrap-password     # sign in at http://localhost:9121 with this
```

`bun run dev` restarts on changes (`bun run start` runs without that). State goes in `data/`;
set `CS_DATA_DIR` to an absolute path for a separate, throwaway instance, and `PORT` to run
on another port. HTTPS, passkeys, providers and the herdr backend are covered in
[local development](docs/local-dev.md).

To try the `cs` CLI from your checkout, see [installing it](docs/cli.md#install).

## Tests

```bash
bun test                                  # everything, about 10 seconds
bun test server/handoff.test.ts           # one suite
bun test cli/                             # the CLI's suites
```

Every change that touches behavior comes with tests, and `bun test` must pass. Tests sit
next to the code they cover (`server/mcp.ts` → `server/mcp.test.ts`). Mock external CLIs
and accounts: never log out a real account or use a real workspace as a fixture.

`bunx tsc --noEmit` currently reports existing type errors on `main`; don't add new ones.

The installer has its own Python tests (some only run on Linux; CI runs them all):

```bash
python3 -m unittest -v deploy/tests/test_installer.py
```

For UI changes, check the app at phone (390 px) and desktop widths, in light and dark.
Changes to session lifecycle, installs or updates also need a check on Linux; a pass on
macOS doesn't prove them (see [local development](docs/local-dev.md#verification)).

## Where things live

| Folder | What's there |
| --- | --- |
| `server/` | The Bun server: HTTP API, auth, sessions, MCP (`mcp.ts`), connectors, secrets, and their tests |
| `public/` | The web app (vanilla JS PWA), served as is with no build step |
| `cli/` | The `cs` command-line client (`cs.ts`, helpers in `cs-lib.ts`) |
| `deploy/` | The server installer, the `coding-sessions` admin command, systemd units and their tests |
| `docker/`, `Dockerfile` | The Docker image and its entrypoint |
| `docs/` | User docs: install, CLI, MCP, agents, connectors, security |
| `scripts/` | Helper scripts |

## Pull requests

1. Fork the repo, or branch if you have access, from an up-to-date `main`:
   `git switch -c fix/short-name origin/main`.
2. Keep each PR to one change. Update the docs in `docs/` and the README when behavior
   people see changes.
3. Run `bun test` before pushing.
4. Open the PR against `main` and fill in the template: what it does, why, and what you
   verified (and what you didn't).

CI runs the real installer on Ubuntu and Debian and builds the Docker image for every pull
request. A maintainer reviews and merges; releases are tagged `vX.Y.Z` and listed in
[CHANGELOG.md](CHANGELOG.md).

### Commit messages

Short, present tense, saying what changes for the user, in the
[Conventional Commits](https://www.conventionalcommits.org) style the history uses:

```text
feat(chat): the agent's slash commands, from a "/" menu
fix(install): repair owners and modes with doctor --fix and every setup
docs(secrets): agent guidance and security model for secret requests
test: the stale socket scenario uses the app's own socket name
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor` and `chore`, with an optional
scope such as `mcp`, `chat`, `install` or `pwa`.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
