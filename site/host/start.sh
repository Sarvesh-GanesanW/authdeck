#!/bin/sh
# Run on the machine that hosts the website, as the user that owns ~/authdeck-site (no sudo).
# Starts two systemd user services: Caddy serving ~/authdeck-site/www on 127.0.0.1:8735, and
# cloudflared publishing it on https://authdeck.in through the Cloudflare Tunnel "authdeck-site".
# Safe to run again; it restarts both, so run it after changing the Caddyfile.
set -eu

SITE_DIR="$HOME/authdeck-site/www"
UNIT_DIR="$HOME/.config/systemd/user"
STATE_DIR="$HOME/.local/state/authdeck-site"
TOKEN_FILE="$HOME/.config/authdeck-site/tunnel.env"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Prints the program's path from PATH or ~/.local/bin (where a user-level install puts it).
find_program() {
  command -v "$1" 2>/dev/null && return
  [ -x "$HOME/.local/bin/$1" ] && echo "$HOME/.local/bin/$1"
  return 0
}

CADDY="$(find_program caddy)"
[ -n "$CADDY" ] || { echo "Caddy isn't installed. Put the caddy binary in ~/.local/bin: https://caddyserver.com/download" >&2; exit 1; }
CLOUDFLARED="$(find_program cloudflared)"
[ -n "$CLOUDFLARED" ] || { echo "cloudflared isn't installed. Put the cloudflared binary in ~/.local/bin: https://github.com/cloudflare/cloudflared/releases" >&2; exit 1; }
[ -f "$SITE_DIR/index.html" ] || { echo "No site in $SITE_DIR yet. Run site/deploy.sh from the AuthDeck repo first." >&2; exit 1; }
[ -f "$TOKEN_FILE" ] || { echo "No tunnel token in $TOKEN_FILE. Put TUNNEL_TOKEN=<the token of the Cloudflare Tunnel \"authdeck-site\"> in it, then run this again." >&2; exit 1; }
chmod 600 "$TOKEN_FILE"

mkdir -p "$UNIT_DIR" "$STATE_DIR/caddy-config" "$STATE_DIR/caddy-data"
sed "s|CADDY|$CADDY|" "$HERE/authdeck-site-web.service" > "$UNIT_DIR/authdeck-site-web.service"
sed "s|CLOUDFLARED|$CLOUDFLARED|" "$HERE/authdeck-site-tunnel.service" > "$UNIT_DIR/authdeck-site-tunnel.service"
systemctl --user daemon-reload
systemctl --user enable authdeck-site-web.service authdeck-site-tunnel.service
systemctl --user restart authdeck-site-web.service authdeck-site-tunnel.service

# Keep both running after logout and across reboots.
loginctl enable-linger "$(id -un)" 2>/dev/null || echo "Couldn't turn on lingering; the site stops while you're logged out. Run: sudo loginctl enable-linger $(id -un)"

systemctl --user --no-pager --lines=0 status authdeck-site-web.service authdeck-site-tunnel.service
