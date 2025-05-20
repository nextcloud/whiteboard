#!/bin/bash
# SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

set -e

# Set required environment variables
# For DSP deployment, use APP_PORT if available, otherwise default to 3002
if [ -n "$APP_PORT" ] && [ -z "$HP_SHARED_KEY" ]; then
    export PORT="$APP_PORT"
    echo "DSP deployment detected, using APP_PORT: $APP_PORT"
else
    export PORT=3002
    echo "HaRP deployment or standalone, using default port: 3002"
fi
export TLS=false
export COMPRESSION_ENABLED=true
export JWT_SECRET_KEY="$APP_SECRET"
export NEXTCLOUD_URL="$NC_INSTANCE_URL"

# Only create a config file if HP_SHARED_KEY is set.
if [ -n "$HP_SHARED_KEY" ]; then
    echo "HP_SHARED_KEY is set, creating /frpc.toml configuration file..."
    if [ -d "/certs/frp" ]; then
        echo "Found /certs/frp directory. Creating configuration with TLS certificates."
        cat <<EOF > /frpc.toml
serverAddr = "$HP_FRP_ADDRESS"
serverPort = $HP_FRP_PORT
loginFailExit = false

transport.tls.enable = true
transport.tls.certFile = "/certs/frp/client.crt"
transport.tls.keyFile = "/certs/frp/client.key"
transport.tls.trustedCaFile = "/certs/frp/ca.crt"
transport.tls.serverName = "harp.nc"

metadatas.token = "$HP_SHARED_KEY"

[[proxies]]
name = "nextcloud_whiteboard"
type = "tcp"
localIP = "127.0.0.1"
localPort = $PORT
remotePort = $APP_PORT
EOF
    else
        echo "Directory /certs/frp not found. Creating configuration without TLS certificates."
        cat <<EOF > /frpc.toml
serverAddr = "$HP_FRP_ADDRESS"
serverPort = $HP_FRP_PORT
loginFailExit = false

transport.tls.enable = false

metadatas.token = "$HP_SHARED_KEY"

[[proxies]]
name = "nextcloud_whiteboard"
type = "tcp"
localIP = "127.0.0.1"
localPort = $PORT
remotePort = $APP_PORT
EOF
    fi
else
    echo "HP_SHARED_KEY is not set. Skipping FRP configuration."
fi

# Start the main application in the background
echo "Starting application: npm start"
npm start &

# Give the server a moment to start
echo "Waiting for server to start..."
sleep 3

# If we have a configuration file and the shared key is present, start the FRP client
if [ -f /frpc.toml ] && [ -n "$HP_SHARED_KEY" ]; then
    echo "Starting frpc in the background..."
    frpc -c /frpc.toml &
fi

# Keep the container running
echo "Services started, waiting..."
wait