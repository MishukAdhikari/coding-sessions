import grp
import json
import os
import platform
import pwd
import socket
import stat
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class InstallerContractTests(unittest.TestCase):
    def check(self, *extra):
        return subprocess.run([
            "bash", str(ROOT / "deploy/install-ubuntu"), "--check",
            "--instance", "demo", "--origin", "https://sessions.example.test",
            "--port", "9121", "--bun", "/bin/sh", *extra,
        ], capture_output=True, text=True)

    def test_valid_check_is_nonmutating_and_uses_instance_paths(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("user=cs-demo home=/var/lib/coding-sessions/demo", result.stdout)

    def test_rejects_unsafe_values_before_mutating(self):
        cases = [
            ("--instance", "../root"), ("--instance", "demo-"),
            ("--origin", "http://example.test"),
            ("--origin", "https://example.test/path"),
            ("--origin", "https://example.test:443"),
            ("--origin", "https://-bad.example.test"),
            ("--origin", "https://bad-.example.test"),
            ("--origin", "https://a..test"),
            ("--port", "80"), ("--port", "65536"),
            ("--port", "9121\nOTHER=value"),
        ]
        for args in cases:
            with self.subTest(args=args):
                self.assertNotEqual(self.check(*args).returncode, 0)

    def test_requires_exact_download_digest_and_version(self):
        result = subprocess.run([
            "bash", str(ROOT / "deploy/install-ubuntu"), "--check",
            "--instance", "demo", "--origin", "https://sessions.example.test",
            "--port", "9121", "--bun-version", "latest", "--bun-sha256", "abc",
        ], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_herdr_is_opt_in_pinned_and_checksummed(self):
        result = self.check("--herdr")
        self.assertEqual(result.returncode, 0, result.stderr)
        usage = subprocess.run(["bash", str(ROOT / "deploy/install-ubuntu"), "--help"], capture_output=True, text=True)
        self.assertIn("--herdr", usage.stdout)
        installer = (ROOT / "deploy/install-ubuntu").read_text()
        self.assertIn("herdr=0", installer)
        self.assertIn("https://github.com/herdrdev/herdr/releases/download/v0.9.5/$herdr_file", installer)
        self.assertIn("'herdr 0.9.5'", installer)
        for asset, digest in [("herdr-linux-x86_64", "14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d"),
                              ("herdr-linux-aarch64", "17d7536f2da50859523680ef279dffcac8e4a235f4e46fe8da6c2ec44141897c")]:
            self.assertIn(f"herdr_file={asset} herdr_sum={digest}", installer)
        self.assertIn('printf \'%s  %s\\n\' "$herdr_sum" "$herdr_tmp" | sha256sum --check --status', installer)
        self.assertIn('install -o root -g root -m 0755 "$herdr_tmp" /usr/local/bin/herdr', installer)
        self.assertIn("CS_MUX=$mux", installer)
        self.assertNotIn("CS_MUX=screen", installer)

    def test_setup_passes_herdr_through_to_the_installer(self):
        cli = (ROOT / "deploy/coding-sessions").read_text()
        self.assertIn("--herdr) HERDR=yes; shift ;;", cli)
        self.assertIn("[[ ${HERDR:-no} = yes ]] && args+=(--herdr)", cli)
        self.assertIn("--herdr                           opt-in: install pinned herdr", cli)

    def test_reset_password_is_root_only_and_keeps_the_password_off_argv_and_logs(self):
        cli = (ROOT / "deploy/coding-sessions").read_text()
        body = cli.split("cmd_reset_password() {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("need_root reset-password", body)
        self.assertIn("reset-password) cmd_reset_password \"$@\" ;;", cli)
        self.assertIn('printf \'%s\\n\' "$pw" | AS_INPUT=1', body)
        log = [line for line in body.splitlines() if "logger" in line]
        self.assertEqual(len(log), 1)
        self.assertNotIn("$out", log[0])
        self.assertNotIn("$pw", log[0])
        result = subprocess.run(["bash", str(ROOT / "deploy/coding-sessions"), "reset-password"], capture_output=True, text=True)
        if os.geteuid() != 0:
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("run as root", result.stderr)

    def test_app_updater_picks_newest_stable_release_tag(self):
        result = subprocess.run(["bash", str(ROOT / "deploy/update-app"), "--newest-release"],
            input="v0.1.9\nv0.10.0\nv0.2.0\nv1.0.0-rc1\nnot-a-tag\nv0.9.12\n", capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "v0.10.0")
        none = subprocess.run(["bash", str(ROOT / "deploy/update-app"), "--newest-release"], input="main\n", capture_output=True, text=True)
        self.assertEqual((none.returncode, none.stdout.strip()), (0, ""))

    def test_preset_agents_install_and_update_from_their_official_npm_packages(self):
        installer = (ROOT / "deploy/install-provider-clis").read_text()
        updater = (ROOT / "deploy/update-coding-clis").read_text()
        for provider, package, binary in [("gemini", "@google/gemini-cli", "gemini"), ("kimi", "@moonshot-ai/kimi-code", "kimi"),
                                          ("qwen", "@qwen-code/qwen-code", "qwen"), ("opencode", "opencode-ai", "opencode")]:
            with self.subTest(provider=provider):
                self.assertIn(f"{provider}) echo '{package} {binary} ", installer)
                self.assertIn(f"'{package} {binary}'", updater)
        self.assertIn("kimi) echo '@moonshot-ai/kimi-code kimi 22.19.0'", installer)
        unknown = subprocess.run(["bash", str(ROOT / "deploy/install-provider-clis"), "nope"], capture_output=True, text=True,
                                 env={**os.environ, "HOME": tempfile.gettempdir()})
        self.assertNotEqual(unknown.returncode, 0)
    @unittest.skipUnless(shutil.which("timeout"), "needs coreutils timeout, as on Ubuntu")
    def test_app_updater_reads_the_settings_channel_only_as_a_fixed_word(self):
        def choice(content=None, link=False):
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "app-update-channel"
                if link:
                    target = Path(tmp) / "target"
                    target.write_text("main\n")
                    path.symlink_to(target)
                elif content is not None:
                    path.write_text(content)
                result = subprocess.run(["bash", str(ROOT / "deploy/update-app"), "--channel-choice", str(path)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result.stdout.strip()
        self.assertEqual(choice("main\n"), "main")
        self.assertEqual(choice("releases\n"), "releases")
        self.assertEqual(choice("releases"), "releases")
        for bad in ["mainline\n", "main; rm -rf /\n", "Main\n", "", "releases-x"]:
            with self.subTest(content=bad):
                self.assertEqual(choice(bad), "")
        self.assertEqual(choice(), "")
        self.assertEqual(choice(link=True), "")
        with tempfile.TemporaryDirectory() as tmp:
            fifo = Path(tmp) / "app-update-channel"
            os.mkfifo(fifo)
            result = subprocess.run(["bash", str(ROOT / "deploy/update-app"), "--channel-choice", str(fifo)], capture_output=True, text=True, timeout=10)
            self.assertEqual((result.returncode, result.stdout.strip()), (0, ""))
        updater = (ROOT / "deploy/update-app").read_text()
        self.assertIn('channel_choice "$instance_home/data/app-update-channel" runuser -u "cs-$instance" --', updater)

    def test_app_updater_rejects_bad_instances_and_needs_root(self):
        for instance in ["", "../etc", "Demo", "demo-"]:
            with self.subTest(instance=instance):
                self.assertNotEqual(subprocess.run(["bash", str(ROOT / "deploy/update-app"), instance], capture_output=True, text=True).returncode, 0)
        if os.geteuid() != 0:
            result = subprocess.run(["bash", str(ROOT / "deploy/update-app"), "demo"], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("root", result.stderr)

    def test_app_update_units_are_installed_and_checked_with_the_others(self):
        installer = (ROOT / "deploy/install-ubuntu").read_text()
        for unit in ["coding-sessions-app-update@.service", "coding-sessions-app-update@.timer"]:
            self.assertTrue((ROOT / "deploy/templates" / unit).is_file())
            self.assertGreaterEqual(installer.count(unit), 2)
        self.assertIn('systemctl enable --now "coding-sessions-app-update@$instance.timer"', installer)

    def test_updater_only_updates_installed_providers_and_persists_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            binaries = home / ".local/bin"
            binaries.mkdir(parents=True)
            calls = home / "calls"
            for name, body in {
                "codex": "#!/bin/bash\necho codex-test\n",
                "npm": '#!/bin/bash\nprintf "%s\\n" "$*" >> "$UPDATE_TEST_CALLS"\nexit 1\n',
            }.items():
                binary = binaries / name
                binary.write_text(body)
                binary.chmod(0o755)
            result = subprocess.run(
                ["bash", str(ROOT / "deploy/update-coding-clis")],
                env={**os.environ, "HOME": str(home), "UPDATE_TEST_CALLS": str(calls)},
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 1)
            logged = calls.read_text()
            self.assertIn("@openai/codex@latest", logged)
            self.assertNotIn("command-code", logged)
            status = json.loads((home / ".local/state/coding-cli-updates/status.json").read_text())
            self.assertEqual(status["result"], "failed")
            self.assertIsNotNone(status["finished"])

    def test_setup_keeps_a_running_build_newer_than_the_cli_release(self):
        script = (ROOT / "deploy/coding-sessions").read_text()
        function = script[script.index("keep_running_source() {"):script.index("# The source to install from")]
        self.assertIn('[[ -n ${VERSION:-} ]] || keep_running_source', script)
        with tempfile.TemporaryDirectory() as directory:
            src, app = Path(directory) / "src", Path(directory) / "app"
            src.mkdir(); app.mkdir()
            def git(*args):
                return subprocess.run(["git", "-C", str(src), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                                      check=True, capture_output=True, text=True).stdout.strip()
            git("init", "-q")
            git("commit", "-q", "--allow-empty", "-m", "one"); old = git("rev-parse", "HEAD")
            git("commit", "-q", "--allow-empty", "-m", "two"); new = git("rev-parse", "HEAD")
            def run(running, fetched):
                (app / ".source-commit").write_text(running + "\n")
                (app / ".source-version").write_text("v0.15.0\n")
                git("checkout", "-q", "--force", fetched)
                harness = f'set -euo pipefail\nwarn() {{ :; }}\napp_dir() {{ printf %s {app}; }}\n{function}\n' \
                          f'SRC={src} INSTANCE=demo SOURCE_REF=v0.14.0 SOURCE_COMMIT={fetched}\nkeep_running_source\n' \
                          'printf "%s %s %s" "$SOURCE_REF" "$SOURCE_COMMIT" "$(git -C "$SRC" rev-parse HEAD)"\n'
                result = subprocess.run(["bash", "-c", harness], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result.stdout.split()
            self.assertEqual(run(new, old), ["v0.15.0", new, new])   # the app moved on: stay there
            self.assertEqual(run(old, new), ["v0.14.0", new, new])   # an upgrade goes ahead
            self.assertEqual(run(new, new), ["v0.14.0", new, new])
            self.assertEqual(run("0" * 40, old), ["v0.14.0", old, old])  # unknown commit: as before

    @unittest.skipIf(os.geteuid() == 0, "the agent installer refuses to run as root")
    def test_agent_install_falls_back_to_bun_when_npm_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "home"
            tools = Path(directory) / "tools"
            home.mkdir()
            tools.mkdir()
            calls = Path(directory) / "calls"
            for path, body in {
                tools / "node": "#!/bin/sh\nexit 0\n",
                tools / "npm": '#!/bin/sh\necho "npm $*" >> "$INSTALL_TEST_CALLS"\necho "npm error Class extends value undefined" >&2\nexit 1\n',
                tools / "bun": '#!/bin/sh\ncase "$1" in\n  add) echo "bun $*" >> "$INSTALL_TEST_CALLS";;\n  -e) echo "$PWD/entry.js";;\n  *) echo 9.9.9;;\nesac\n',
            }.items():
                path.write_text(body)
                path.chmod(0o755)
            result = subprocess.run(
                ["bash", str(ROOT / "deploy/install-provider-clis"), "gemini"],
                env={"HOME": str(home), "PATH": f"{tools}:/usr/bin:/bin", "CS_BUN": str(tools / "bun"), "INSTALL_TEST_CALLS": str(calls)},
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("installing it under Bun instead", result.stdout)
            self.assertEqual(calls.read_text().splitlines(), [
                f"npm install --global --prefix {home}/.local @google/gemini-cli@latest",
                "bun add --backend=copyfile @google/gemini-cli@latest",
            ])
            launcher = home / ".local/bin/gemini"
            self.assertTrue(launcher.is_file() and not launcher.is_symlink())
            self.assertIn("9.9.9", result.stdout)

    def test_updater_refreshes_a_bun_installed_agent_with_the_installer_not_npm(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "home"
            binaries = home / ".local/bin"
            binaries.mkdir(parents=True)
            (home / ".local/share/coding-sessions/packages/codex").mkdir(parents=True)
            scripts = Path(directory) / "deploy"
            scripts.mkdir()
            shutil.copy(ROOT / "deploy/update-coding-clis", scripts / "update-coding-clis")
            calls = Path(directory) / "calls"
            for path, body in {
                binaries / "codex": "#!/bin/sh\necho codex-test\n",
                binaries / "npm": '#!/bin/bash\necho "npm $*" >> "$UPDATE_TEST_CALLS"\nexit 1\n',
                scripts / "install-provider-clis": '#!/bin/bash\necho "installer $*" >> "$UPDATE_TEST_CALLS"\n',
            }.items():
                path.write_text(body)
                path.chmod(0o755)
            result = subprocess.run(
                ["bash", str(scripts / "update-coding-clis")],
                env={**os.environ, "HOME": str(home), "UPDATE_TEST_CALLS": str(calls)},
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(calls.read_text(), "installer codex\n")

    def proxy_functions(self):
        script = (ROOT / "deploy/coding-sessions").read_text()
        return script[script.index("pick_proxy() {"):script.index("install_nginx() {")]

    def test_setup_picks_the_web_server_already_on_80_and_443(self):
        functions = self.proxy_functions()
        def pick(owners, want="auto"):
            harness = (f'set -euo pipefail\ndie() {{ printf "%s" "$*" >&2; exit 1; }}\n'
                       f'port_owner() {{ case $1 in 80) printf %s "{owners[0]}";; 443) printf %s "{owners[1]}";; esac; }}\n'
                       f'{functions}\nPROXY=$(pick_proxy {want})\nprintf %s "$PROXY"\n')
            r = subprocess.run(["bash", "-c", harness], capture_output=True, text=True)
            return (r.returncode, r.stdout, r.stderr)
        self.assertEqual(pick(("", "")), (0, "caddy", ""))                 # a clean server gets Caddy
        self.assertEqual(pick(("nginx", "nginx")), (0, "nginx", ""))       # a panel-built server keeps its nginx
        self.assertEqual(pick(("caddy", "")), (0, "caddy", ""))
        self.assertEqual(pick(("", ""), "nginx"), (0, "nginx", ""))        # asked for on a clean server
        code, _, err = pick(("nginx", "nginx"), "caddy")
        self.assertEqual(code, 1); self.assertIn("use --proxy nginx", err)
        code, _, err = pick(("lshttpd", "lshttpd"))
        self.assertEqual(code, 1); self.assertIn("port 80 is used by lshttpd", err)
        code, _, err = pick(("caddy", "nginx"))
        self.assertEqual(code, 1); self.assertIn("different servers", err)
        code, _, err = pick(("", ""), "apache")
        self.assertEqual(code, 1); self.assertIn("auto, caddy or nginx", err)

    def test_the_nginx_site_goes_where_nginx_conf_includes_sites(self):
        functions = self.proxy_functions()
        # Only the files on disk move to the temporary folder; the include lines still name /etc/nginx.
        for path in ["main=/etc/nginx/nginx.conf", "-d /etc/nginx/sites-enabled"]:
            self.assertIn(path, functions)
            functions = functions.replace(path, path.replace("/etc/nginx", "$NGX"))
        with tempfile.TemporaryDirectory() as ngx:
            def site(conf, sites_enabled=True):
                Path(ngx, "nginx.conf").write_text(conf)
                d = Path(ngx, "sites-enabled")
                if sites_enabled: d.mkdir(exist_ok=True)
                elif d.exists(): d.rmdir()
                harness = f'set -euo pipefail\nNGX={ngx} INSTANCE=demo\n{functions}\nnginx_site_path\n'
                r = subprocess.run(["bash", "-c", harness], capture_output=True, text=True)
                return r.stdout if r.returncode == 0 else None
            debian = "http {\n    include /etc/nginx/conf.d/*.conf;\n    include /etc/nginx/sites-enabled/*;\n}\n"
            self.assertEqual(site(debian), "/etc/nginx/sites-enabled/coding-sessions-demo.conf")
            self.assertEqual(site("http {\n  include /etc/nginx/conf.d/*.conf;\n}\n", False), "/etc/nginx/conf.d/coding-sessions-demo.conf")
            self.assertEqual(site("http {\n  # include /etc/nginx/sites-enabled/*;\n  include /etc/nginx/conf.d/*.conf;\n}\n"), "/etc/nginx/conf.d/coding-sessions-demo.conf")
            self.assertIsNone(site("http {\n  include /opt/panel/sites/*.conf;\n}\n"))

    def test_setup_routes_install_status_doctor_and_uninstall_through_the_chosen_proxy(self):
        script = (ROOT / "deploy/coding-sessions").read_text()
        for needle in ["  install_proxy\n", "  configure_proxy\n", 'PROXY=$(conf_get PROXY); PROXY=${PROXY:-caddy}',
                       'check "nginx configuration valid"', 'coding-sessions-$INSTANCE.conf', "--proxy) want_proxy="]:
            self.assertIn(needle, script)
        self.assertNotIn("  install_caddy\n  [[", script)
        template = (ROOT / "deploy/templates/nginx.conf").read_text()
        for needle in ["proxy_set_header Upgrade $http_upgrade;", "proxy_set_header X-Real-IP $remote_addr;", "proxy_read_timeout 3600s;"]:
            self.assertIn(needle, template)


@unittest.skipUnless(platform.system() == "Linux", "the permission pass uses GNU find and stat, as on Ubuntu")
class PermissionPassTests(unittest.TestCase):
    """`coding-sessions permissions` over a fake root (CS_PERM_PREFIX), owned by the test's own user."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.chmod(self.tmp, 0o755)
        self.root = Path(self.tmp)
        self.user = os.environ.get("CS_TEST_SVC_USER") or pwd.getpwuid(os.geteuid()).pw_name
        self.home = self.root / "var/lib/coding-sessions/demo"
        etc = self.root / "etc/coding-sessions"
        (etc / "instances").mkdir(parents=True)
        (etc / "instances/demo").write_text("coding-sessions:demo\n")
        (etc / "demo.env").write_text("HOME=/x\nPATH=/usr/bin:/bin\nPORT=9121\n")
        (etc / "credentials/demo").mkdir(parents=True)
        for name in ["admin-password", "token-encryption-key"]:
            (etc / "credentials/demo" / name).write_text("secret\n")
        (self.root / "opt/coding-sessions/demo/releases/r1").mkdir(parents=True)
        (self.root / "opt/coding-sessions/demo/releases/r1/index.ts").write_text("x\n")
        (self.home / "data").mkdir(parents=True)
        (self.home / "data/app.db").write_text("db\n")
        self.env = {**os.environ, "CS_PERM_PREFIX": self.tmp, "CS_PERM_ROOT_USER": pwd.getpwuid(os.geteuid()).pw_name,
                    "CS_PERM_SVC_USER": self.user, "INSTANCE": "demo"}
        # Start from the modes setup leaves, then break some of them.
        self.run_cli("--fix", "--yes")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_cli(self, *args):
        return subprocess.run(["bash", str(ROOT / "deploy/coding-sessions"), "permissions", "--instance", "demo", *args],
                              env=self.env, capture_output=True, text=True)

    def mode(self, path):
        return stat.S_IMODE(os.lstat(path).st_mode)

    def test_the_table_sets_every_expected_owner_and_mode(self):
        etc = self.root / "etc/coding-sessions"
        self.assertEqual(self.mode(etc / "demo.env"), 0o600)
        self.assertEqual(self.mode(etc / "credentials"), 0o700)
        self.assertEqual(self.mode(etc / "credentials/demo/admin-password"), 0o600)
        self.assertEqual(self.mode(self.home), 0o700)
        for directory in ["data", "run", "run/screen", ".config", ".local", ".local/bin", ".local/state"]:
            with self.subTest(directory=directory):
                self.assertTrue((self.home / directory).is_dir())
                self.assertEqual(self.mode(self.home / directory), 0o700)
        self.assertIn(f"PATH={self.home}/.local/bin:", (etc / "demo.env").read_text())

    def test_check_reports_each_problem_with_path_and_expected_value_and_fix_repairs_it(self):
        env = self.root / "etc/coding-sessions/demo.env"
        env.chmod(0o644)
        (self.home / "data/app.db").chmod(0o400)
        (self.root / "opt/coding-sessions/demo/releases/r1/index.ts").chmod(0o666)
        shutil.rmtree(self.home / "run")
        check = self.run_cli()
        self.assertNotEqual(check.returncode, 0)
        self.assertIn(f"{env} — is ", check.stdout)
        self.assertIn("expected", check.stdout)
        self.assertIn("0600", check.stdout)
        self.assertIn("readonly database", check.stdout)
        self.assertIn(f"{self.home}/run — missing", check.stdout)
        self.assertIn("doctor --fix", check.stdout)
        self.assertEqual(self.mode(env), 0o644)  # check changes nothing
        fixed = self.run_cli("--fix", "--yes")
        self.assertEqual(fixed.returncode, 0, fixed.stdout + fixed.stderr)
        self.assertEqual(self.mode(env), 0o600)
        self.assertTrue(self.mode(self.home / "data/app.db") & stat.S_IWUSR)
        self.assertEqual(self.mode(self.root / "opt/coding-sessions/demo/releases/r1/index.ts") & 0o022, 0)
        self.assertTrue((self.home / "run/screen").is_dir())

    def test_the_pass_is_idempotent(self):
        (self.home / "data/app.db").chmod(0o400)
        self.run_cli("--fix", "--yes")
        again = self.run_cli("--fix", "--yes")
        self.assertEqual(again.returncode, 0, again.stdout)
        self.assertNotIn("—", again.stdout)
        check = self.run_cli()
        self.assertEqual(check.returncode, 0, check.stdout)
        self.assertIn("owners and modes of every Coding Sessions path", check.stdout)

    def test_symlinks_at_managed_paths_are_refused_never_followed(self):
        target = self.root / "elsewhere"
        target.write_text("not ours\n")
        target.chmod(0o644)
        env = self.root / "etc/coding-sessions/demo.env"
        env.unlink()
        env.symlink_to(target)
        result = self.run_cli("--fix", "--yes")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is a symlink", result.stdout)
        self.assertIn(f"sudo mv '{env}'", result.stdout)
        self.assertTrue(env.is_symlink())
        self.assertEqual(self.mode(target), 0o644)
        self.assertEqual(target.read_text(), "not ours\n")

    def test_a_stale_socket_is_removed(self):
        path = self.home / "data/cs.sock"
        server = socket.socket(socket.AF_UNIX)
        server.bind(str(path))
        server.close()  # bound, never listening: what a crash leaves
        self.assertIn("stale socket", self.run_cli().stdout)
        self.run_cli("--fix", "--yes")
        self.assertFalse(path.exists())

    @unittest.skipUnless(os.geteuid() == 0, "needs root to leave root-owned files, as sudo npm i -g does")
    def test_root_run_leftovers_in_the_home_are_handed_back_without_following_links(self):
        svc = os.environ.get("CS_TEST_SVC_USER", "nobody")
        self.env["CS_PERM_SVC_USER"] = svc
        uid, gid = pwd.getpwnam(svc).pw_uid, grp.getgrgid(pwd.getpwnam(svc).pw_gid).gr_gid
        for path in [self.home, *self.home.rglob("*")]:
            os.lchown(path, uid, gid)
        leftovers = [self.home / ".local/lib/node_modules/x/index.js", self.home / ".codex/auth.json", self.home / "workspaces/repo/.git/index"]
        for path in leftovers:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("root wrote this\n")
        victim = self.root / "root-only"
        victim.write_text("x\n")
        (self.home / ".local/link").symlink_to(victim)
        self.assertIn("left by a command run as root", self.run_cli().stdout)
        result = self.run_cli("--fix", "--yes")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for path in leftovers:
            with self.subTest(path=path):
                self.assertEqual(os.lstat(path).st_uid, uid)
                self.assertEqual(os.lstat(path.parent).st_uid, uid)
        self.assertEqual(os.lstat(self.home / ".local/link").st_uid, uid)
        self.assertEqual(os.stat(victim).st_uid, 0)
        self.assertEqual(self.run_cli().returncode, 0)


if __name__ == "__main__":
    unittest.main()
