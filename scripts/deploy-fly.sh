#!/bin/sh
# First deploy to Fly.io (London). Run from the project root after `fly auth login`.
#   scripts/deploy-fly.sh <app-name> <username> [<username> ...]
# Prompts for each user's password, creates the encryption key, stores both as Fly
# secrets (never on disk), creates the data volume and deploys.
set -eu
[ $# -ge 2 ] || { echo "usage: $0 <app-name> <username> [<username> ...]"; exit 1; }
APP=$1; shift

fly apps create "$APP" 2>/dev/null || echo "App $APP already exists, continuing"
sed -i.bak "s/^app = .*/app = \"$APP\"/" fly.toml && rm fly.toml.bak

USERS=""
for NAME in "$@"; do
  printf "Password for %s (12+ characters): " "$NAME"; stty -echo; read -r PASS; stty echo; echo
  [ ${#PASS} -ge 12 ] || { echo "Too short"; exit 1; }
  LINE=$(node server.js hash-password "$NAME" "$PASS")
  USERS="${USERS:+$USERS;}$LINE"
done

if fly secrets list -a "$APP" | grep -q DATA_KEY; then
  echo "DATA_KEY already set, keeping it"
  fly secrets set -a "$APP" --stage AUTH_USERS="$USERS"
else
  KEY=$(node server.js gen-key)
  fly secrets set -a "$APP" --stage AUTH_USERS="$USERS" DATA_KEY="$KEY"
  echo
  echo "Encryption key (store it in a password manager NOW; without it the data cannot be read):"
  echo "$KEY"
  echo
fi

fly volumes list -a "$APP" | grep -q wp_data || fly volumes create wp_data -a "$APP" -r lhr -s 1 -y
fly deploy -a "$APP" --ha=false
echo "Live at https://$APP.fly.dev"
