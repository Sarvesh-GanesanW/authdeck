#!/bin/sh
# Builds the website and copies it, with the current release's downloads, to the machine that
# serves it. The host is an SSH destination (default: the "authdeck-site" alias in ~/.ssh/config).
# Old downloads on the host are removed, so only the current release stays published.
#
#   site/deploy.sh                 # build and publish
#   AUTHDECK_SITE_HOST=me@box site/deploy.sh
set -eu

HOST="${AUTHDECK_SITE_HOST:-authdeck-site}"
REMOTE_DIR="authdeck-site"
SITE="$(cd "$(dirname "$0")" && pwd)"

node "$SITE/build.mjs"
ssh "$HOST" "mkdir -p $REMOTE_DIR/www $REMOTE_DIR/host"
rsync -a --delete "$SITE/out/" "$HOST:$REMOTE_DIR/www/"
rsync -a --delete "$SITE/host/" "$HOST:$REMOTE_DIR/host/"
echo "Published to $HOST:$REMOTE_DIR/www. First time on this host? Run $REMOTE_DIR/host/start.sh there."
