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
