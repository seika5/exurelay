#!/usr/bin/env bash
# Install (or upgrade) a Relay server on a fresh Ubuntu 22.04/24.04 host: PostgreSQL, Node.js, Caddy (HTTPS) and
# coturn (TURN for calls), with secrets generated, system services and a one-time setup code for the first admin.
#
#   sudo bash install.sh                       # address from this host's public IP: https://203-0-113-5.sslip.io
#   sudo bash install.sh --domain relay.example.com   # your own domain (its A record must point here first)
#
# Run it again at any time to upgrade: it pulls the code, keeps every secret and restarts the services.
# Environment overrides: RELAY_DOMAIN, RELAY_REPO, RELAY_BRANCH (same as the flags).
set -euo pipefail

DOMAIN="${RELAY_DOMAIN:-}"
REPO="${RELAY_REPO:-https://github.com/seika5/relay.git}"
BRANCH="${RELAY_BRANCH:-main}"
DIR=/opt/relay
SERVER="$DIR/relay-server"
ENV_FILE="$SERVER/.env"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash install.sh)"
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "this script is for Ubuntu (found ${ID:-unknown})"
export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------------------------------------------
say "Installing packages"
# Small hosts (512 MB-1 GB) run out of memory during npm ci without some swap.
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ] && ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git openssl postgresql coturn debian-keyring debian-archive-keyring apt-transport-https
install -d -m 0755 /etc/apt/keyrings
systemctl enable -q --now postgresql

node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)'; }
if ! node_ok; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q && apt-get install -y -q nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

# ---------------------------------------------------------------------------------------------------------------
say "Finding this server's address"
public_ip() { curl -4fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]'; }
# A static IP attached just after boot (Lightsail, an Elastic IP) changes the address: wait until it settles.
IP="$(public_ip)"
for _ in 1 2 3 4 5 6 7 8; do
  sleep 15
  NOW="$(public_ip)"
  [ "$NOW" = "$IP" ] && break
  IP="$NOW"
done
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "couldn't find the public IPv4 address (got '$IP')"
PRIVATE_IP="$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1)}')"

if [ -z "$DOMAIN" ] && [ -f "$ENV_FILE" ]; then
  # Upgrading: keep the address it already has, unless it was an sslip.io name for an IP this host no longer has.
  OLD="$(sed -n 's|^PUBLIC_URL=https://||p' "$ENV_FILE")"
  case "$OLD" in *.sslip.io) ;; *) DOMAIN="$OLD" ;; esac
fi
if [ -z "$DOMAIN" ]; then
  DOMAIN="${IP//./-}.sslip.io"
else
  RESOLVED="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}')"
  [ "$RESOLVED" = "$IP" ] || echo "Warning: $DOMAIN points at '${RESOLVED:-nothing}', not this server ($IP). HTTPS won't work until it does."
fi
URL="https://$DOMAIN"
echo "Address: $URL"
if [ -n "${OLD:-}" ] && [ "$OLD" != "$DOMAIN" ]; then
  echo "Warning: the address changes from https://$OLD. Everyone needs a new join code (Settings -> Admin) to reach it."
fi

# ---------------------------------------------------------------------------------------------------------------
say "Getting the code"
id relay >/dev/null 2>&1 || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin relay
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q --depth 1 origin "$BRANCH" && git -C "$DIR" reset -q --hard FETCH_HEAD
else
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi
chown -R relay:relay "$DIR"
cd "$SERVER"
sudo -u relay npm ci --no-audit --no-fund --loglevel=error

# ---------------------------------------------------------------------------------------------------------------
say "Database and secrets"
envget() { [ -f "$ENV_FILE" ] && sed -n "s|^$1=||p" "$ENV_FILE" | tr -d '"' || true; }
DB_PASS="$(envget DATABASE_URL | sed -n 's|^postgresql://relay:\([^@]*\)@.*|\1|p')"
[ -n "$DB_PASS" ] || DB_PASS="$(openssl rand -hex 24)"
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='relay'" | grep -q 1; then
  sudo -u postgres psql -qc "ALTER ROLE relay WITH LOGIN PASSWORD '$DB_PASS'"
else
  sudo -u postgres psql -qc "CREATE ROLE relay WITH LOGIN PASSWORD '$DB_PASS'"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='relay'" | grep -q 1 || sudo -u postgres createdb --owner relay relay

TURN_SECRET="$(envget TURN_SECRET)"; [ -n "$TURN_SECRET" ] || TURN_SECRET="$(openssl rand -hex 32)"
SETUP_CODE="$(envget SETUP_CODE)"; [ -n "$SETUP_CODE" ] || SETUP_CODE="$(openssl rand -hex 16 | sed 's/..../&-/g; s/-$//')"
VAPID_PUBLIC_KEY="$(envget VAPID_PUBLIC_KEY)"; VAPID_PRIVATE_KEY="$(envget VAPID_PRIVATE_KEY)"
if [ -z "$VAPID_PUBLIC_KEY" ] || [ -z "$VAPID_PRIVATE_KEY" ]; then
  eval "$(sudo -u relay node -e "const k=require('web-push').generateVAPIDKeys(); console.log('VAPID_PUBLIC_KEY='+k.publicKey+'; VAPID_PRIVATE_KEY='+k.privateKey)")"
fi
ADMIN_SIGNING_KEYS="$(envget ADMIN_SIGNING_KEYS)"

umask 077
cat > "$ENV_FILE" <<EOF
# Written by deploy/install.sh; rerunning it keeps the secrets below. See .env.example for every setting.
PORT=4000
HOST=127.0.0.1
DATABASE_URL="postgresql://relay:$DB_PASS@127.0.0.1:5432/relay"
PUBLIC_URL=$URL
# One-time code that lets the first admin claim this server from the app; does nothing once a member list exists.
SETUP_CODE=$SETUP_CODE
ADMIN_SIGNING_KEYS=$ADMIN_SIGNING_KEYS
TURN_SECRET=$TURN_SECRET
TURN_URLS=turn:$DOMAIN:3478,turns:$DOMAIN:5349?transport=tcp
STUN_URLS=stun:$DOMAIN:3478
VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY
VAPID_SUBJECT=$URL
EOF
umask 022
chown relay:relay "$ENV_FILE"
sudo -u relay npx prisma generate >/dev/null
sudo -u relay npx prisma db push --skip-generate || die "the database schema changed in a way that loses data. Read README.md §1.7 (Upgrading)."

# ---------------------------------------------------------------------------------------------------------------
say "Services"
for svc in api worker; do
  entry=index.js; [ "$svc" = worker ] && entry=worker.js
  cat > "/etc/systemd/system/relay-$svc.service" <<EOF
[Unit]
Description=Relay $svc
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=relay
WorkingDirectory=$SERVER
ExecStart=$(command -v node) src/$entry
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
done
systemctl daemon-reload
systemctl enable -q relay-api relay-worker
systemctl restart relay-api relay-worker

say "HTTPS (Caddy)"
sed "s|^relay.example.com {|$DOMAIN {|" "$SERVER/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl enable -q caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "TURN (coturn)"
# coturn can't read Caddy's certificate store: copy the certificate over whenever Caddy renews it.
cat > /usr/local/bin/relay-turn-certs <<EOF
#!/bin/sh
set -e
src="\$(find /var/lib/caddy/.local/share/caddy/certificates -name '$DOMAIN.crt' 2>/dev/null | head -n 1)"
[ -n "\$src" ] || exit 0
install -d -m 0750 -o root -g turnserver /etc/coturn/certs
if ! cmp -s "\$src" /etc/coturn/certs/relay.crt; then
  install -m 0640 -o root -g turnserver "\$src" /etc/coturn/certs/relay.crt
  install -m 0640 -o root -g turnserver "\${src%.crt}.key" /etc/coturn/certs/relay.key
  systemctl restart coturn
fi
EOF
chmod 0755 /usr/local/bin/relay-turn-certs
cat > /etc/systemd/system/relay-turn-certs.service <<'EOF'
[Unit]
Description=Copy the Relay HTTPS certificate for coturn

[Service]
Type=oneshot
ExecStart=/usr/local/bin/relay-turn-certs
EOF
cat > /etc/systemd/system/relay-turn-certs.timer <<'EOF'
[Unit]
Description=Copy the Relay HTTPS certificate for coturn, twice a day

[Timer]
OnBootSec=2min
OnUnitActiveSec=12h

[Install]
WantedBy=timers.target
EOF

sed -e "s|^static-auth-secret=.*|static-auth-secret=$TURN_SECRET|" \
    -e "s|^realm=.*|realm=$DOMAIN|" \
    -e "s|^cert=.*|cert=/etc/coturn/certs/relay.crt|" \
    -e "s|^pkey=.*|pkey=/etc/coturn/certs/relay.key|" \
    "$SERVER/deploy/turnserver.conf" > /etc/turnserver.conf
# Behind 1:1 NAT (AWS, Lightsail) the host only knows its private address: tell coturn the public one.
if [ -n "$PRIVATE_IP" ] && [ "$PRIVATE_IP" != "$IP" ]; then echo "external-ip=$IP/$PRIVATE_IP" >> /etc/turnserver.conf; fi
chown root:turnserver /etc/turnserver.conf && chmod 0640 /etc/turnserver.conf
[ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl daemon-reload
systemctl enable -q --now relay-turn-certs.timer
systemctl enable -q coturn

# Firewall: only if ufw is on (cloud firewalls, e.g. Lightsail's, are set up separately).
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw allow 3478 >/dev/null; ufw allow 5349/tcp >/dev/null; ufw allow 49152:65535/udp >/dev/null
fi

say "Waiting for the HTTPS certificate"
for _ in $(seq 1 40); do
  curl -fsS --max-time 5 "$URL/health" >/dev/null 2>&1 && break
  sleep 3
done
/usr/local/bin/relay-turn-certs
systemctl restart coturn
curl -fsS --max-time 5 "$URL/health" >/dev/null 2>&1 || echo "Warning: $URL isn't answering yet. Check that ports 80 and 443 are open, then: journalctl -u caddy"

# ---------------------------------------------------------------------------------------------------------------
# Shown at every SSH login until the server is claimed, so a server set up from "user data" still shows its code.
cat > /etc/update-motd.d/99-relay <<EOF
#!/bin/sh
if curl -fsS --max-time 3 http://127.0.0.1:4000/api/directory 2>/dev/null | grep -q '"directory":null'; then
  echo
  echo "Relay server: $URL"
  echo "Setup code:   \$(sed -n 's/^SETUP_CODE=//p' $ENV_FILE)"
  echo "In the app: I'm setting up a new server -> this address -> your name -> the setup code -> Create member list."
  echo
fi
EOF
chmod 0755 /etc/update-motd.d/99-relay

say "Done"
if curl -fsS --max-time 3 http://127.0.0.1:4000/api/directory 2>/dev/null | grep -q '"directory":null'; then
  cat <<EOF

  Relay server: $URL
  Setup code:   $SETUP_CODE

  In the app, choose "I'm setting up a new server", enter the address above and your name, then enter the setup
  code and press "Create member list". The code works once: whoever uses it first becomes the admin.
  It's also shown each time you log in here until then.

EOF
else
  echo "Upgraded. Server: $URL"
fi
