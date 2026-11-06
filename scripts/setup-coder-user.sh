#!/usr/bin/env bash
# Give an external coding agent (Claude Code, Codex, ...) its own unprivileged Linux user on the host
# that runs Vigil, so Switch Console can run it there as the `patch-author` in #vigil-hotfix.
#
# Run once, as root, on the Vigil host. From your own machine:
#
#   ssh root@<host> "CODER_PUBKEY='$(cat ~/.ssh/id_ed25519.pub)' bash -s" < scripts/setup-coder-user.sh
#
# What it does, and nothing else:
#   - creates the group `vigil-coders` and the user `vigil-coder` (no password, no sudo), with ids
#     no process on the host uses: container processes often run as 1000/1001 without a name in
#     /etc/passwd, and sharing their id would let the coder signal them or write their files
#   - moves an existing `vigil-coder` onto those ids if it was created with clashing ones
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
CODER_UID="${CODER_UID:-2600}"        # the user, and its own primary group
CODER_GROUP_GID="${CODER_GROUP_GID:-2601}"
: "${CODER_PUBKEY:?Pass your SSH public key as CODER_PUBKEY (see the header).}"

[ "$(id -u)" = 0 ] || { echo "Run as root." >&2; exit 1; }
[ -f "$VIGIL_DIR/CLAUDE.md" ] || { echo "No Vigil checkout at $VIGIL_DIR." >&2; exit 1; }

# An id is free when no named user/group has it and no running process (containers included) uses it.
id_in_use_by_processes() { ps -eo uid=,gid= | awk -v i="$1" '$1==i || $2==i {f=1} END {exit !f}'; }
need_free_id() {
  local id="$1" what="$2"
  if id_in_use_by_processes "$id"; then echo "Id $id ($what) is used by running processes; pick another with CODER_UID/CODER_GROUP_GID." >&2; exit 1; fi
}

# The shared group.
if getent group "$CODER_GROUP" >/dev/null; then
  current="$(getent group "$CODER_GROUP" | cut -d: -f3)"
  if [ "$current" != "$CODER_GROUP_GID" ]; then
    need_free_id "$CODER_GROUP_GID" "$CODER_GROUP"
    groupmod -g "$CODER_GROUP_GID" "$CODER_GROUP"
    echo "Moved group $CODER_GROUP from gid $current to $CODER_GROUP_GID."
  fi
else
  need_free_id "$CODER_GROUP_GID" "$CODER_GROUP"
  groupadd -g "$CODER_GROUP_GID" "$CODER_GROUP"
fi

# The user and its own group.
if id "$CODER_USER" >/dev/null 2>&1; then
  old_uid="$(id -u "$CODER_USER")"
  old_gid="$(id -g "$CODER_USER")"
  if [ "$old_uid" != "$CODER_UID" ] || [ "$old_gid" != "$CODER_UID" ]; then
    need_free_id "$CODER_UID" "$CODER_USER"
    # usermod refuses while any process runs as the old uid, and containers that share that number
    # count, so edit the entries directly. Only this user's own files are re-owned below.
    # groupmod also rewrites the user's group field in /etc/passwd, so match the line by name only.
    [ "$(getent group "$CODER_USER" | cut -d: -f3)" = "$CODER_UID" ] || groupmod -g "$CODER_UID" "$CODER_USER"
    sed -i "s/^$CODER_USER:x:[0-9]*:[0-9]*:/$CODER_USER:x:$CODER_UID:$CODER_UID:/" /etc/passwd
    [ "$(id -u "$CODER_USER")" = "$CODER_UID" ] || { echo "Could not change $CODER_USER's uid." >&2; exit 1; }
    chown -R -h "$CODER_UID:$CODER_UID" "$(getent passwd "$CODER_USER" | cut -d: -f6)"
    echo "Moved user $CODER_USER from uid $old_uid/gid $old_gid to $CODER_UID/$CODER_UID."
  fi
  usermod -a -G "$CODER_GROUP" "$CODER_USER"
else
  need_free_id "$CODER_UID" "$CODER_USER"
  groupadd -g "$CODER_UID" "$CODER_USER"
  useradd -m -s /bin/bash -u "$CODER_UID" -g "$CODER_UID" -G "$CODER_GROUP" "$CODER_USER"
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
