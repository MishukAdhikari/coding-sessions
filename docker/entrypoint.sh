#!/usr/bin/env bash
# Prepare the persistent home on first start, then run the app in the foreground.
set -euo pipefail
umask 077

: "${ORIGIN:?Set ORIGIN to the https:// address people will open, e.g. https://sessions.example.com}"

for directory in data run run/screen .config .local .local/bin workspaces; do
  mkdir -p "$HOME/$directory"
done
chmod 0700 "$HOME" "$HOME/data" "$HOME/run" "$HOME/run/screen"

# Stored tokens are encrypted with a key that never leaves the volume.
if [[ -z ${CS_TOKEN_KEY_FILE:-} ]]; then
  export CS_TOKEN_KEY_FILE=$HOME/data/token-encryption-key
  [[ -s $CS_TOKEN_KEY_FILE ]] || head -c 32 /dev/urandom | base64 > "$CS_TOKEN_KEY_FILE"
  chmod 0600 "$CS_TOKEN_KEY_FILE"
fi

# Scrollable web terminals: screen otherwise uses the alternate buffer.
[[ -e $HOME/.screenrc ]] || printf 'termcapinfo xterm*|xterms|xs|rxvt ti@:te@\ndefscrollback 10000\ndefutf8 on\n' > "$HOME/.screenrc"

if [[ ! -e $HOME/data/app.db ]]; then
  echo "First start. Sign in at $ORIGIN with the password from:"
  echo "  docker compose exec app cat /home/cs/data/bootstrap-password"
fi

cd /app
exec bun server/index.ts
