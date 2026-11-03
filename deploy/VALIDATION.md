# Ubuntu installer validation

Validated on 2026-10-31 using disposable, unprivileged Docker containers with no host mounts or published ports. Both images used x86_64 and reviewed Bun 1.3.14 with its pinned release SHA-256. No production service, user, workspace or credential was changed by these tests.

| Environment | Evidence |
| --- | --- |
| Ubuntu 24.04.5 | Fresh installation and rerun with `--no-start`; generated credentials and environment preserved byte-for-byte, existing data sentinel retained; instantiated app/updater/timer units pass `systemd-analyze verify`. |
| Ubuntu 26.04 | Fresh `--no-start --daily-updates --codex-hooks` installation succeeds; instantiated units verify; `gh` installed; instance home mode 0700, admin credential 0600, managed Codex requirements 0644. |
| Ubuntu 24.04 runtime | Dedicated instance UID runs Bun through `setpriv --no-new-privs`; HTTP starts, SQLite mode 0600, anonymous account access rejected, generated-password login succeeds, missing providers reported unavailable. |
| Ubuntu 24.04 terminal | API creates a real screen shell; authenticated HTTP and WebSocket relay reaches ttyd through a private Unix socket; shell prints the requested marker and reconnect prints another marker. Socket mode 0600; owning UID can connect, a second instance UID cannot; no ttyd listener in the legacy 7700–7799 TCP range. Cross-origin terminal mutation returns 403. |
| Refusal/preservation | Existing unmanaged account, conflicting instance port and incompatible Codex requirements are refused. Existing Codex policy remains unchanged. |
| Local contracts | Shell syntax checks and four installer/updater tests pass, including invalid arguments, exact download version/digest requirement, nonmutating check mode and persisted updater failure. |

The containers did not run systemd as PID 1. Credential delivery was emulated with private files owned by the instance user; these checks do **not** establish actual `LoadCredential`, systemd sandbox enforcement, service restart semantics or timer execution. `NoNewPrivileges` was exercised directly for the app and terminal subprocesses. TLS/ACME, Nginx deployment, arm64 execution and real provider login/launch remain operator acceptance checks. No provider authentication or live provider update was performed.

The installed release copies an explicit runtime/document allowlist. The final optional documentation-list expansion was checked locally after the container snapshot; it does not alter runtime behavior. Containers and their temporary upload context were removed after validation.
