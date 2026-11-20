#!/usr/bin/env bash
# v2: read-only diagnostics and isolated static preview. Review before running as root.
set -euo pipefail
if [[ "$(id -u)" -ne 0 ]]; then echo "Run as root" >&2; exit 1; fi
cd "$(dirname "$(readlink -f "$0")")/.."
if ! id eduappbot >/dev/null 2>&1; then
  echo "eduappbot missing: first install bootstrap-ubuntu.sh" >&2; exit 1
fi
if ! grep -q 'command="/usr/local/libexec/eduapp-ops"' /home/eduappbot/.ssh/authorized_keys; then
  echo "Expected forced-command SSH key not found; stop." >&2; exit 1
fi
if ! systemctl is-active --quiet eduapp-preview 2>/dev/null &&
   ss -H -ltn '( sport = :18080 )' | grep -q .; then
  echo "Port 18080 is already in use. No change made." >&2; exit 1
fi

install -d -o eduappbot -g eduappbot -m 750 /var/lib/eduapp-preview
install -d -o eduappbot -g eduappbot -m 750 /var/lib/eduapp-preview/releases
install -d -o eduappbot -g eduappbot -m 750 /var/lib/eduapp-preview/releases/initial
if [[ ! -f /var/lib/eduapp-preview/releases/initial/index.html ]]; then
  printf '%s\n' '<!doctype html><html lang="en"><meta charset="utf-8"><title>eduapp preview</title><h1>eduapp preview ready</h1><p>Deploy from GitHub Actions.</p></html>' > /var/lib/eduapp-preview/releases/initial/index.html
  chown eduappbot:eduappbot /var/lib/eduapp-preview/releases/initial/index.html
fi
if [[ ! -L /var/lib/eduapp-preview/current ]]; then
  ln -s releases/initial /var/lib/eduapp-preview/current
fi
touch /var/lib/eduapp-preview/ops.log
chown eduappbot:eduappbot /var/lib/eduapp-preview/ops.log
chmod 640 /var/lib/eduapp-preview/ops.log

install -d -m 755 /usr/local/libexec
install -o root -g root -m 755 scripts/eduapp-preview-deploy.py /usr/local/libexec/eduapp-preview-deploy.py
cat >/usr/local/libexec/eduapp-ops <<'GATEWAY'
#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
request="${SSH_ORIGINAL_COMMAND:-}"
case "$request" in
  status)
    echo "=== HOST ==="; hostname
    echo "=== UPTIME ==="; uptime
    echo "=== DISK ==="; df -h /
    echo "=== SERVICES ==="
    for service in nginx docker eduapp-preview; do
      printf '%s: ' "$service"; systemctl is-active "$service" || true
    done
    echo "=== ACCESS ==="; id -un
    ;;
  inventory)
    echo "=== SYSTEM ==="; uname -srmo
    echo "=== MEMORY ==="; free -h
    echo "=== DISK ==="; df -h /
    echo "=== PREVIEW DISK ==="; du -sh /var/lib/eduapp-preview
    echo "=== PREVIEW ENDPOINT ==="
    ss -H -ltn '( sport = :18080 )' || true
    echo "=== PREVIEW RELEASE ==="
    readlink /var/lib/eduapp-preview/current || true
    ;;
  logs)
    echo "=== LAST 80 DEPLOYMENT LOG LINES ==="
    tail -n 80 /var/lib/eduapp-preview/ops.log
    ;;
  test)
    /usr/bin/python3 -c 'from urllib.request import urlopen; r=urlopen("http://127.0.0.1:18080/",timeout=8); print("Preview HTTP:",r.status,"bytes:",len(r.read(500000)))'
    ;;
  rollback)
    exec /usr/bin/python3 /usr/local/libexec/eduapp-preview-deploy.py rollback
    ;;
  deploy-static\ *)
    sha="${request#deploy-static }"
    if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
      echo "Denied: expected a 40-character Git commit SHA" >&2; exit 2
    fi
    exec /usr/bin/python3 /usr/local/libexec/eduapp-preview-deploy.py deploy "$sha"
    ;;
  *)
    echo "Denied. Allowed: status, inventory, logs, test, rollback, deploy-static <commit-sha>" >&2
    exit 2
    ;;
esac
GATEWAY
chown root:root /usr/local/libexec/eduapp-ops
chmod 755 /usr/local/libexec/eduapp-ops

cat >/etc/systemd/system/eduapp-preview.service <<'UNIT'
[Unit]
Description=Isolated eduapp static preview (loopback only)
After=network.target

[Service]
Type=simple
User=eduappbot
Group=eduappbot
WorkingDirectory=/var/lib/eduapp-preview
ExecStart=/usr/bin/python3 -m http.server 18080 --bind 127.0.0.1 --directory /var/lib/eduapp-preview/current
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0027
MemoryMax=160M
TasksMax=40

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now eduapp-preview
echo "=== INSTALLED ==="
systemctl is-active eduapp-preview
echo "Service listens ONLY on 127.0.0.1:18080; Nginx, Docker, SSH and other sites were not modified."
echo "Existing SSH secret and key were not changed."
