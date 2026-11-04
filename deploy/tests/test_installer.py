import json
import os
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


if __name__ == "__main__":
    unittest.main()
