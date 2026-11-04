---
name: install-coding-sessions
description: Install, repair or update a Coding Sessions server for someone. Use when asked to install, set up, deploy or self-host Coding Sessions, or to get it running on a VPS, Ubuntu, Debian or Docker. Grills the user one round at a time with recommended answers before running anything.
---

# Install Coding Sessions

You are helping someone run Coding Sessions on their own server. The `coding-sessions` CLI does the work; your job is to reach a shared understanding of their choices, then run or hand over the exact command.

## 1. Read before you ask

Read these first, so your questions and recommendations come from the docs, not memory:

- `README.md`: "Get started", "Trust model", "Third-party software and services".
- `docs/install.md`: supported platforms, what `coding-sessions setup` does, its flags.
- `docs/agents.md`: the coding agents, who makes them, how each signs in.

## 2. Find facts yourself

Facts are your job, never the user's. Check them instead of asking:

- **Server OS:** if you can reach the server, run `cat /etc/os-release`, `uname -m`, `free -h` and `df -h /`.
- **DNS:** `dig +short <domain>` or `getent ahosts <domain>`, compared with the server's IP.
- **Whether it's already installed:** `command -v coding-sessions` and `cat /etc/coding-sessions/setup.conf`.

Only questions whose answers depend on unknown facts wait for those facts.

## 3. Grill in rounds

Treat the install as a design tree. Each round, ask every question whose prerequisites are settled. Number them and give your recommended answer, worded so "yes" accepts it:

```
❓ **Q1** - **<title>**: <question, with the options>

➡️ <recommended answer>
```

Then wait. Their answers unlock the next round. The tree:

1. **Where it runs**
   - **Ubuntu or Debian server they can SSH into:** recommended.
   - **Another Linux with Docker:** use `docs/docker.md`.
   - **This machine:** only for trying it out.

   If the server's OS is unsupported (see `docs/install.md`), steer them to Docker.
2. **Domain:** a hostname whose DNS A/AAAA record points at the server, e.g. `sessions.example.com`. If they have none, explain they need one for HTTPS and passkeys, and stop until they do. If DNS doesn't point at the server yet, give them the exact record to add.
3. **Email** for the HTTPS certificate (Let's Encrypt expiry notices).
4. **Coding agents to install.** Choose any; nothing is installed by default.
   - Claude Code, Codex, Command Code.
   - Presets: Gemini CLI, Kimi Code, Qwen Code, opencode.

   Each is a third-party tool with its own account and terms. Recommend the ones they already pay for or use.
5. **Playwright browser (Chromium):** lets agents open and test web pages. Recommend yes when the server has 2 GB or more of RAM.
6. **Automatic updates:** daily app and agent updates. A new app version is kept only if it starts cleanly. Recommend yes.
7. **Small-server tuning:** only ask if RAM is under 4 GB. Add 2 GB of swap? Recommend yes.
8. **Anything unusual you found:**
   - ports 80/443 already in use;
   - a Cloudflare proxy in front of the domain (use `--skip-dns-check`);
   - an existing install. In that case setup repairs or updates it. Re-running setup can change agents, browser and updates, but not the domain or port; a new domain means a new instance (`--instance`).

Stop when nothing is left silently assumed. Summarise every choice in one list and ask them to confirm.

## 4. Run it

Build the command from their answers:

```bash
curl -fsSLO https://github.com/MishukAdhikari/coding-sessions/releases/latest/download/install.sh
curl -fsSLO https://github.com/MishukAdhikari/coding-sessions/releases/latest/download/install.sh.sha256
sha256sum -c install.sh.sha256
sudo bash install.sh --domain <domain> --email <email> --agents <a,b|none> \
  [--browser|--no-browser] [--updates|--no-updates] [--swap|--no-swap] --no-link --yes
```

Then:

- **Running it:** if you have SSH access and the user said yes to running it, run it there and watch the output. Otherwise give them the commands.
- **`--no-link`:** when you run setup yourself, always pass it, so the sign-in link never appears in your output. The user gets the link themselves in step 5.
- **Already installed:** use `sudo coding-sessions setup …` with the same flags.
- **Previewing:** `--dry-run` prints the plan without changing anything. Use it first if they are unsure.

## 5. After it finishes

1. **Sign-in:**
   - **If you ran setup:** you passed `--no-link`, so ask the user to run `sudo coding-sessions setup-link` in **their own** terminal.
   - **If they ran it:** the output ends with the link.

   They open it, press **Sign in with this link**, then add a passkey. It works once and expires in 30 minutes.
2. Agents sign in from the app:
   - **Claude Code, Codex, Command Code:** Settings → Agent authentication.
   - **Presets:** Settings → Commands, or the server terminal. See `docs/agents.md`.
3. `sudo coding-sessions doctor` checks everything and says how to fix what's wrong.

## Never

- **Credentials:** never ask for, print, store or paste the sign-in link, passwords, tokens or API keys. Never run `setup-link` yourself.
- **Asking first:** never run setup, `uninstall` or anything that changes a server without the user's explicit yes in this conversation.
- **Lockout risks:** never change SSH settings, disable root login, or reset the firewall. The CLI doesn't, and neither should you.
- **Root:** never install agents as root. The CLI installs them as the service account.
