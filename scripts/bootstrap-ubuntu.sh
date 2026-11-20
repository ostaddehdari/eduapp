#!/usr/bin/env bash
# Bootstrap a strictly read-only SSH status gateway for GitHub-hosted Actions.
# Review this script before running it as root.
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

BOT=eduappbot
KEY_DIR=/root/eduapp-gh-bridge
KEY_FILE="$KEY_DIR/github_actions_ed25519"
GATEWAY=/usr/local/libexec/eduapp-ops

if ! id "$BOT" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$BOT"
fi

install -d -m 755 /usr/local/libexec
cat > "$GATEWAY" <<'GATEWAY_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
# Invoked only via authorized_keys forced-command. The requested SSH
# command is available in SSH_ORIGINAL_COMMAND, never executed as shell.
case "${SSH_ORIGINAL_COMMAND:-}" in
  status)
    echo "=== HOST ==="
    hostname
    echo "=== UPTIME ==="
    uptime
    echo "=== DISK ==="
    df -h /
    echo "=== SERVICES ==="
    for service in nginx docker; do
      printf '%s: ' "$service"
      systemctl is-active "$service" || true
    done
    echo "=== ACCESS ==="
    id -un
    ;;
  *)
    echo "Denied: only the 'status' command is permitted." >&2
    exit 2
    ;;
esac
GATEWAY_SCRIPT
chown root:root "$GATEWAY"
chmod 755 "$GATEWAY"

install -d -m 700 -o "$BOT" -g "$BOT" "/home/$BOT/.ssh"
install -d -m 700 "$KEY_DIR"
if [[ ! -f "$KEY_FILE" ]]; then
  (umask 077; ssh-keygen -q -t ed25519 -N '' -C 'eduapp-github-actions-status' -f "$KEY_FILE")
fi

PUB_KEY="$(cat "$KEY_FILE.pub")"
AUTH="/home/$BOT/.ssh/authorized_keys"
touch "$AUTH"
if ! grep -Fq "$PUB_KEY" "$AUTH"; then
  printf 'restrict,command="%s" %s\n' "$GATEWAY" "$PUB_KEY" >> "$AUTH"
fi
chown "$BOT:$BOT" "$AUTH"
chmod 600 "$AUTH"

echo
echo "Bootstrap complete: public-key-only, read-only SSH gateway installed."
echo "Private key path for GitHub secret UBUNTU_SSH_PRIVATE_KEY: $KEY_FILE"
echo "Host public-key type and value (for UBUNTU_SSH_KNOWN_HOSTS):"
awk '{ print $1, $2 }' /etc/ssh/ssh_host_ed25519_key.pub
echo "Prefix that output with [YOUR_SERVER_HOST]:2233 and a space."
echo "Do not send the private key into chat. Put it directly into GitHub Secrets."
echo "After saving the secret, remove the temporary server-side private key."
