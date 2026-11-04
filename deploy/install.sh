#!/usr/bin/env bash
# Coding Sessions installer. Download it, check it, read it, then run it:
#
#   curl -fsSLO https://github.com/MishukAdhikari/coding-sessions/releases/latest/download/install.sh
#   curl -fsSLO https://github.com/MishukAdhikari/coding-sessions/releases/latest/download/install.sh.sha256
#   sha256sum -c install.sh.sha256 && less install.sh
#   sudo bash install.sh
#
# It fetches the release this file was published with (pinned to its exact commit),
# installs the `coding-sessions` command, and starts its guided setup. Options are
# passed through to `coding-sessions setup`: --domain, --email, --agents, --yes, …
# Everything runs inside main(), so a partly downloaded file runs nothing.
set -euo pipefail

main() {
  local version="dev" commit=""   # stamped by the release workflow
  local repo="https://github.com/MishukAdhikari/coding-sessions.git"
  local src=/usr/local/lib/coding-sessions/source

  [[ $(id -u) = 0 ]] || { echo "Run it with sudo: sudo bash install.sh" >&2; exit 1; }
  [[ $(uname -s) = Linux && -r /etc/os-release ]] || { echo "Coding Sessions installs on Linux (Ubuntu or Debian). Elsewhere, use Docker: docs/docker.md" >&2; exit 1; }
  if ! command -v git >/dev/null; then
    command -v apt-get >/dev/null || { echo "This installer supports Ubuntu and Debian. Elsewhere, use Docker: docs/docker.md" >&2; exit 1; }
    echo "Installing git…"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null
  fi

  install -d -m 0755 /usr/local/lib/coding-sessions
  if [[ -d $src/.git ]]; then
    git -c safe.directory="$src" -C "$src" fetch --quiet --tags --force origin
  else
    rm -rf -- "$src"
    git clone --quiet --no-checkout "$repo" "$src"
  fi
  local ref=$version
  if [[ $ref = dev ]]; then
    ref=$(git -c safe.directory="$src" -C "$src" tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)
  fi
  git -c safe.directory="$src" -C "$src" -c advice.detachedHead=false checkout --quiet --force "$ref"
  if [[ -n $commit ]]; then
    [[ $(git -c safe.directory="$src" -C "$src" rev-parse HEAD) = "$commit" ]] \
      || { echo "Release $ref doesn't match the commit this installer was published with. Stopping." >&2; exit 1; }
  fi
  sed "s/^CLI_VERSION=\"dev\"/CLI_VERSION=\"$ref\"/" "$src/deploy/coding-sessions" > /usr/local/bin/.coding-sessions.tmp
  chmod 0755 /usr/local/bin/.coding-sessions.tmp
  mv -f /usr/local/bin/.coding-sessions.tmp /usr/local/bin/coding-sessions
  echo "Installed the coding-sessions command ($ref). Starting setup…"
  exec /usr/local/bin/coding-sessions setup "$@"
}

main "$@"
