#!/bin/sh
set -eu
umask 077
ssh_dir="${HOME:-/home/gxzs}/.ssh"
mkdir -p "$ssh_dir"
chmod 700 "$ssh_dir"
host_key="$ssh_dir/ssh_host_ed25519_key"
if [ ! -f "$host_key" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$host_key"
fi
touch "$ssh_dir/authorized_keys"
if [ -n "${GXZS_SANDBOX_AUTHORIZED_KEY:-}" ]; then
  printf '%s\n' "$GXZS_SANDBOX_AUTHORIZED_KEY" > "$ssh_dir/authorized_keys"
fi
chmod 600 "$host_key" "$ssh_dir/authorized_keys"
# Listen before the manager installs the owner key. An empty key file permits
# no login; readiness must fail if sshd cannot start.
# sshd replaces the inherited environment for authenticated sessions. Preserve
# the image's runtime search paths for the remote helper and its child tools.
/usr/sbin/sshd -p "${GXZS_SANDBOX_SSH_PORT:-2222}" -h "$host_key" \
  -o "PidFile=$ssh_dir/sshd.pid" -o "AuthorizedKeysFile=$ssh_dir/authorized_keys" \
  -o "SetEnv=PATH=$PATH NODE_PATH=${NODE_PATH:-}" \
  -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o UsePAM=no \
  -o PermitRootLogin=no -o StrictModes=yes -o PrintMotd=no \
  -o AllowTcpForwarding=no -o AllowStreamLocalForwarding=no -o AllowAgentForwarding=no \
  -o X11Forwarding=no -o MaxSessions=256 -o MaxStartups=256
exec "$@"
