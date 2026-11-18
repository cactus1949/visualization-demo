#!/usr/bin/env bash
# 给浏览器地址栏里的 IP 或域名签一张自签证书，写到安装目录的 certs/。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
NAME=${1:-}

if [[ -z "$NAME" ]]; then
  echo "用法: bin/self-signed.sh <浏览器地址栏里的 IP 或域名>" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "找不到 openssl" >&2
  exit 1
fi

if [[ "$NAME" =~ ^[0-9.]+$ || "$NAME" == *:* ]]; then
  SAN="IP:${NAME}"
else
  SAN="DNS:${NAME}"
fi

DEST="$ROOT/certs"
mkdir -p "$DEST"
CFG=$(mktemp)
trap 'rm -f "$CFG"' EXIT
cat > "$CFG" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no
[dn]
CN = ${NAME}
[v3_req]
subjectAltName = ${SAN}
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
EOF

umask 077
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout "$DEST/server.key" \
  -out "$DEST/server.crt" \
  -config "$CFG"
chmod 644 "$DEST/server.crt"
chmod 600 "$DEST/server.key"

echo "证书  $DEST/server.crt"
echo "私钥  $DEST/server.key"
echo "SAN    $SAN"
echo "浏览器仍会提示不受信任。继续访问之后，地址是 https 时才会带上 br。"
