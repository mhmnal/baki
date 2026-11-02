#!/usr/bin/env bash
# One-time local HTTPS setup for Baki.
#
# Creates a private Certificate Authority (CA) and a server certificate for
# this laptop's LAN IP, so Chrome treats the tracker as a secure site:
# install works, the offline cache works, and there is no "Not secure" warning
# once the CA is trusted on each device.
#
#   ./tools/setup-https.sh
#
# Re-run it if your Wi-Fi IP changes.
set -euo pipefail

cd "$(dirname "$0")/.."

# ---------- find this machine's LAN IP ----------
IP="${TRACKER_IP:-}"
if [ -z "$IP" ]; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
if [ -z "$IP" ]; then
  IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
fi
if [ -z "$IP" ]; then
  echo "Could not detect a LAN IP. Pass it explicitly: TRACKER_IP=192.168.1.7 ./tools/setup-https.sh" >&2
  exit 1
fi

command -v openssl >/dev/null 2>&1 || { echo "openssl is required (sudo apt install openssl)." >&2; exit 1; }

mkdir -p tls
cd tls
chmod 700 .

echo "→ Using LAN IP: $IP"

# ---------- private CA ----------
if [ ! -f ca.key ] || [ ! -f ca.crt ]; then
  openssl req -x509 -new -nodes -newkey rsa:2048 \
    -keyout ca.key -out ca.crt -days 3650 -sha256 \
    -subj "/O=Baki Local/CN=Baki Local CA" 2>/dev/null
  echo "  created private CA (ca.crt, ca.key)"
else
  echo "  reusing existing CA (ca.crt)"
fi

# ---------- server certificate for this IP ----------
cat > server.cnf <<EOF
[req]
distinguished_name = dn
req_extensions = ext
prompt = no

[dn]
O = Baki Local
CN = $IP

[ext]
subjectAltName = @alt
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt]
IP.1 = $IP
DNS.1 = localhost
IP.2 = 127.0.0.1
EOF

openssl req -new -nodes -newkey rsa:2048 -keyout server.key -out server.csr \
  -config server.cnf 2>/dev/null

openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 825 -sha256 -extfile server.cnf -extensions ext 2>/dev/null

rm -f server.csr server.cnf
chmod 600 ca.key server.key

# ---------- laptop trust ----------
if [ -d /usr/local/share/ca-certificates ] && command -v update-ca-certificates >/dev/null 2>&1; then
  if sudo -n true 2>/dev/null; then
    echo "  installing the CA on this laptop (for curl and other tools)"
    sudo cp ca.crt /usr/local/share/ca-certificates/grab-money-local-ca.crt || true
    sudo update-ca-certificates >/dev/null 2>&1 || true
  else
    echo "  skipped laptop-wide CA install (no sudo); Chrome on the laptop will ask once"
  fi
fi

cat <<EOF

  Done.

  Phone address : https://$IP:8443   ← use this one
  Laptop        : https://localhost:8443

  Next, on the phone (once):
    1. Open http://$IP:8787/ca.crt  and save the file
       (Chrome shows "Not secure" — that's fine, it's just a certificate)
    2. Settings → Security → Encryption & credentials
       → Install a certificate → CA certificate → install it
    3. Open https://$IP:8443 and install the app

  If your Wi-Fi IP changes, re-run: ./tools/setup-https.sh
  Certificates live in ./tls/ (safe to keep; do not share ca.key).
EOF
