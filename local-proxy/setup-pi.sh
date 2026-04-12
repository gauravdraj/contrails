#!/usr/bin/env bash
set -euo pipefail

PROXY_DIR="$HOME/opensky-proxy"
SERVICE_NAME="opensky-proxy"

echo "=== Setting up OpenSky proxy on Raspberry Pi ==="

# 1. Install cloudflared if missing
if ! command -v cloudflared &>/dev/null; then
  echo "Installing cloudflared..."
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
  sudo apt-get update && sudo apt-get install -y cloudflared
fi

# 2. Copy proxy server
mkdir -p "$PROXY_DIR"
cp "$(dirname "$0")/server.js" "$PROXY_DIR/server.js"

# 3. Create systemd service for the proxy
sudo tee /etc/systemd/system/${SERVICE_NAME}.service >/dev/null <<EOF
[Unit]
Description=OpenSky Track Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$PROXY_DIR
ExecStart=/usr/bin/node $PROXY_DIR/server.js
Restart=always
RestartSec=5
Environment=PORT=8891
Environment=BIND=127.0.0.1

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ${SERVICE_NAME}
echo "Proxy service started on port 8891"

# 4. Set up cloudflared tunnel
echo ""
echo "=== Cloudflare Tunnel Setup ==="
echo "Run these commands to create the tunnel:"
echo ""
echo "  cloudflared tunnel login"
echo "  cloudflared tunnel create opensky-proxy"
echo "  cloudflared tunnel route dns opensky-proxy opensky.therealgraj.com"
echo ""
echo "Then create the config file:"
echo ""
echo "  mkdir -p ~/.cloudflared"
echo "  cat > ~/.cloudflared/config.yml << 'YAML'"
echo "  tunnel: opensky-proxy"
echo "  credentials-file: /home/$USER/.cloudflared/<TUNNEL_ID>.json"
echo "  ingress:"
echo "    - hostname: opensky.therealgraj.com"
echo "      service: http://localhost:8891"
echo "    - service: http_status:404"
echo "  YAML"
echo ""
echo "Finally install as a service:"
echo ""
echo "  sudo cloudflared service install"
echo "  sudo systemctl enable --now cloudflared"
echo ""
echo "Once done, https://opensky.therealgraj.com/health should return {\"ok\":true}"
