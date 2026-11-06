#!/usr/bin/env bash
# Give an external coding agent (Claude Code, Codex, ...) its own unprivileged Linux user on the host
# that runs Vigil, so Switch Console can run it there as the `patch-author` in #vigil-hotfix.
#
# Run once, as root, on the Vigil host. From your own machine:
#
#   ssh root@<host> "CODER_PUBKEY='$(cat ~/.ssh/id_ed25519.pub)' bash -s" < scripts/setup-coder-user.sh
#
# What it does, and nothing else:
#   - creates the group `vigil-coders` and the user `vigil-coder` (no password, no sudo)
#   - lets your SSH key log in as that user, so Switch Console can onboard the host as it
#   - makes ~vigil-coder/vigil-hotfix the agent's working directory: the CLAUDE.md briefing, pointed
#     at the live working copy, plus a link to that copy
#   - sets VIGIL_SHARED_GROUP=vigil-coders in Vigil's .env and restarts only the `vigil` pm2 process,
#     so the live working copy is rebuilt group-writable for that user
# The user cannot read Vigil's or Switch's .env files (root-only) or write anywhere else under /opt.
set -euo pipefail

CODER_USER="${CODER_USER:-vigil-coder}"
CODER_GROUP="${CODER_GROUP:-vigil-coders}"
VIGIL_DIR="${VIGIL_DIR:-/opt/vigil}"
CHECKOUT_PORT="${CHECKOUT_PORT:-4020}"
: "${CODER_PUBKEY:?Pass your SSH public key as CODER_PUBKEY (see the header).}"

[ "$(id -u)" = 0 ] || { echo "Run as root." >&2; exit 1; }
[ -f "$VIGIL_DIR/CLAUDE.md" ] || { echo "No Vigil checkout at $VIGIL_DIR." >&2; exit 1; }

getent group "$CODER_GROUP" >/dev/null || groupadd "$CODER_GROUP"
if ! id "$CODER_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash -G "$CODER_GROUP" "$CODER_USER"
  passwd -l "$CODER_USER" >/dev/null
fi
HOME_DIR="$(getent passwd "$CODER_USER" | cut -d: -f6)"

install -d -m 700 -o "$CODER_USER" -g "$CODER_USER" "$HOME_DIR/.ssh"
touch "$HOME_DIR/.ssh/authorized_keys"
grep -qxF "$CODER_PUBKEY" "$HOME_DIR/.ssh/authorized_keys" || echo "$CODER_PUBKEY" >> "$HOME_DIR/.ssh/authorized_keys"
chown "$CODER_USER:$CODER_USER" "$HOME_DIR/.ssh/authorized_keys"
chmod 600 "$HOME_DIR/.ssh/authorized_keys"

# The working copy is owned by root; let this user's git work in it.
sudo -u "$CODER_USER" git config --global --replace-all safe.directory '*'
sudo -u "$CODER_USER" git config --global user.name "Claude Code ($CODER_USER)"
sudo -u "$CODER_USER" git config --global user.email "$CODER_USER@localhost"

# The agent's working directory: the briefing, with paths pointing at the live working copy.
LIVE_COPY="$VIGIL_DIR/.vigil-state/checkout-api-live-$CHECKOUT_PORT"
AGENT_DIR="$HOME_DIR/vigil-hotfix"
install -d -m 750 -o "$CODER_USER" -g "$CODER_USER" "$AGENT_DIR"
sed "s#\.vigil-state/checkout-api-live-$CHECKOUT_PORT#$LIVE_COPY#g" "$VIGIL_DIR/CLAUDE.md" > "$AGENT_DIR/CLAUDE.md"
ln -sfn "$LIVE_COPY" "$AGENT_DIR/checkout-api-live"
chown -h "$CODER_USER:$CODER_USER" "$AGENT_DIR/CLAUDE.md" "$AGENT_DIR/checkout-api-live"

# Rebuild the live working copy group-writable for the coder.
if grep -q '^VIGIL_SHARED_GROUP=' "$VIGIL_DIR/.env"; then
  sed -i "s/^VIGIL_SHARED_GROUP=.*/VIGIL_SHARED_GROUP=$CODER_GROUP/" "$VIGIL_DIR/.env"
else
  printf 'VIGIL_SHARED_GROUP=%s\n' "$CODER_GROUP" >> "$VIGIL_DIR/.env"
fi
pm2 restart vigil >/dev/null

echo "Done. $CODER_USER can log in with your key; its agent directory is $AGENT_DIR."
echo "Next: onboard the host in Switch Console as $CODER_USER@<host>, then sign in to Claude there."
