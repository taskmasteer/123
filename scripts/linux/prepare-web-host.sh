#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=l
umask 022
apt-get update -qq
apt-get install -y --no-install-recommends nginx
install -d -m 755 /srv/site-factory/sites /srv/site-factory/acme
install -d -m 700 /var/backups/site-factory/nginx
if [ -L /etc/nginx/sites-enabled/default ]; then
  test "$(readlink -f /etc/nginx/sites-enabled/default)" = /etc/nginx/sites-available/default
  cp -an /etc/nginx/sites-available/default /var/backups/site-factory/nginx/default
  unlink /etc/nginx/sites-enabled/default
fi
cat > /etc/nginx/sites-available/site-factory-default <<'NGINX'
# Managed by Site Factory; unmatched requests never expose a generated site.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    location / { return 404; }
}
NGINX
ln -sfn /etc/nginx/sites-available/site-factory-default /etc/nginx/sites-enabled/site-factory-default
nginx -t
systemctl enable --now nginx
systemctl reload nginx
# Preserve interactive SSH access; the automation key itself is source-restricted.
ufw allow 22/tcp comment 'SSH access'
ufw allow 80/tcp comment 'Site Factory HTTP'
ufw allow 443/tcp comment 'Site Factory HTTPS'
# Leave a recovery timer until an independent SSH + HTTP check succeeds.
systemd-run --quiet --unit=site-factory-firewall-rollback --on-active=180 /usr/sbin/ufw disable
ufw --force enable
ufw status verbose
systemctl is-active nginx
nginx -v
