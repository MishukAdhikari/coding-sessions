#!/usr/bin/env bash
# Prepare the persistent home on first start, then run the app in the foreground.
set -euo pipefail
umask 077

: "${ORIGIN:?Set ORIGIN to the https:// address people will open, e.g. https://sessions.example.com}"

# Started as root (the default): match the cs account to PUID/PGID when given (the owner of a
# bind-mounted folder), hand the home back to it, and drop to it for good. Nothing else runs
# as root. Started with --user: run as that user; the home must already be writable by it.
if [[ $(id -u) = 0 ]]; then
  want_uid=${PUID:-$(id -u cs)} want_gid=${PGID:-$(id -g cs)}
  [[ $want_uid =~ ^[0-9]+$ && $want_gid =~ ^[0-9]+$ && $want_uid != 0 ]] || { echo "PUID and PGID must be numbers, and PUID not 0" >&2; exit 1; }
  [[ $(id -g cs) = "$want_gid" ]] || groupmod -o -g "$want_gid" cs
  [[ $(id -u cs) = "$want_uid" ]] || usermod -o -u "$want_uid" cs
  [[ ! -L $HOME ]] || { echo "$HOME must not be a symlink" >&2; exit 1; }
  # Only what isn't cs's already (a fresh bind mount, files a root `docker exec` left behind).
  # -h: a link in the volume is re-owned itself, never what it points at; hard-linked files are skipped.
  find -P "$HOME" -xdev \( -type d -o ! -type f -o -links 1 \) \( ! -user cs -o ! -group cs \) -exec chown -h cs:cs {} + 2>/dev/null || true
  exec setpriv --reuid=cs --regid=cs --init-groups --inh-caps=-all --bounding-set=-all -- "$0" "$@"
fi
[[ -w $HOME ]] || { echo "$HOME isn't writable by uid $(id -u). Start the container without --user (it fixes ownership itself), or set PUID/PGID to the owner of the mounted folder." >&2; exit 1; }

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
