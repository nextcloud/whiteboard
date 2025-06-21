<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Nextcloud Whiteboard

[![REUSE status](https://api.reuse.software/badge/github.com/nextcloud/whiteboard)](https://api.reuse.software/info/github.com/nextcloud/whiteboard)

The official whiteboard app for Nextcloud. Create and share whiteboards with real-time collaboration.

## Features

- 🎨 Drawing shapes, writing text, connecting elements
- 📝 Real-time collaboration with semi-offline support
- 💾 Client-first architecture with local storage
- 🔄 Automatic sync between local and server storage
- 🌐 Works offline - changes saved locally and synced when online
- 💪 Built on [Excalidraw](https://github.com/excalidraw/excalidraw)

## Architecture

Nextcloud Whiteboard uses a **client-first architecture** that prioritizes local storage and reduces dependency on the websocket server:

- **Local Storage**: All changes are immediately saved to IndexedDB in your browser
- **Semi-Offline Mode**: Continue working even when the collaboration server is unavailable
- **Smart Sync**: Automatic synchronization between local storage, Nextcloud server, and real-time collaboration
- **Reduced Server Dependency**: The websocket server is only needed for real-time collaboration, not basic functionality

## Installation & Setup

### Option 1: External App (Recommended)

Install the whiteboard websocket server as an External App with automatic configuration.

#### Prerequisites

- AppAPI app enabled with a configured deploy daemon ([see AppAPI docs](https://docs.nextcloud.com/server/latest/admin_manual/exapps_management/AppAPIAndExternalApps.html))
- Docker access for your deploy daemon

#### Installation

1. **Install the ExApp**: Go to **Apps** → **External Apps** → Search for **"Nextcloud Whiteboard"**
2. **Wait for deployment**: Installation may take several minutes to pull and start the container
3. **Automatic configuration**: The app will auto-configure collaboration URLs and JWT secrets

#### Whiteboard-Specific Configuration

**Automatic Configuration Verification:**
```bash
# Should auto-configure to ExApp endpoint
occ config:app:get whiteboard collabBackendUrl
# Expected: https://your-domain.com/exapps/nextcloud_whiteboard

# JWT secret should be auto-synchronized with ExApp
occ config:app:get whiteboard jwt_secret_key
```

**Deployment Method Behavior:**
- **HaRP**: Uses WebSocket transport for real-time collaboration
- **DSP**: Falls back to polling transport (higher latency but more compatible)

#### Troubleshooting Whiteboard ExApp

**Auto-configuration Issues:**
```bash
# Force reconfigure if auto-config fails
occ config:app:delete whiteboard collabBackendUrl
# Restart the ExApp to trigger auto-config

# Manual override if needed
occ config:app:set whiteboard collabBackendUrl --value="https://your-domain.com/exapps/nextcloud_whiteboard"
```

**Container Issues:**
```bash
# Check whiteboard container status
docker ps | grep nextcloud_whiteboard

# View container logs for errors
docker logs $(docker ps -q --filter "name=nextcloud_whiteboard")

# Common log patterns to look for:
# - "DSP deployment detected" (polling mode)
# - "HaRP deployment" (websocket mode)
# - JWT secret validation errors
# - Port binding issues
```

**Network Status Verification:**
- Open a whiteboard file and check the network indicator
- **Green "Online"**: Collaboration server connected
- **Red "Offline"**: Check ExApp container and network connectivity
- **Yellow "Connecting"**: Temporary connection issues

**Performance Considerations:**
- DSP deployments use polling (expect ~1-2s latency for real-time updates)
- HaRP deployments use WebSockets (near-instant updates)
- Large whiteboards (>1000 elements) may need container resource adjustments

### Option 2: Manual Server Setup

For custom deployments or development, you can run the websocket server manually:

#### Requirements

- The websocket server needs HTTP(S) access to your Nextcloud instance
- Your Nextcloud server needs HTTP(S) access to the websocket server
- User browsers need HTTP(S) access to the websocket server
- Shared JWT secret between Nextcloud and the websocket server

#### Configuration

Configure Nextcloud with the collaboration server details:

```bash
occ config:app:set whiteboard collabBackendUrl --value="http://nextcloud.local:3002"
occ config:app:set whiteboard jwt_secret_key --value="some-random-secret"
```

#### Running with Node.js

Requires Node 20+ and NPM 10+:

```bash
npm ci
JWT_SECRET_KEY="some-random-secret" NEXTCLOUD_URL=http://nextcloud.local npm run server:start
```

#### Running with Docker

```bash
docker run -e JWT_SECRET_KEY=some-random-secret -e NEXTCLOUD_URL=https://nextcloud.local -p 3002:3002 --rm ghcr.io/nextcloud-releases/whiteboard:release
```

Or using Docker Compose:

```yaml
services:
  whiteboard-server:
    image: ghcr.io/nextcloud-releases/whiteboard:release
    ports:
      - "3002:3002"
    environment:
      NEXTCLOUD_URL: https://nextcloud.local
      JWT_SECRET_KEY: some-random-secret
```

## Reverse Proxy Configuration

If running the websocket server manually, configure your reverse proxy to expose it:

<details>
<summary>Apache Configuration</summary>

**Apache >= 2.4.47:**
```apache
ProxyPass /whiteboard/ http://localhost:3002/ upgrade=websocket
```

**Apache < 2.4.47:**
```apache
ProxyPass /whiteboard/ http://localhost:3002/
RewriteEngine on
RewriteCond %{HTTP:Upgrade} websocket [NC]
RewriteCond %{HTTP:Connection} upgrade [NC]
RewriteRule ^/?whiteboard/(.*) "ws://localhost:3002/$1" [P,L]
```
</details>

<details>
<summary>Nginx Configuration</summary>

```nginx
location /whiteboard/ {
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Host $host;
    proxy_pass http://localhost:3002/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```
</details>

<details>
<summary>Other Reverse Proxies</summary>

**Caddy v2:**
```caddy
handle_path /whiteboard/* {
    reverse_proxy http://127.0.0.1:3002
}
```

**Traefik v3:**
```yaml
- traefik.http.services.whiteboard.loadbalancer.server.port=3002
- traefik.http.middlewares.strip-whiteboard.stripprefix.prefixes=/whiteboard
- traefik.http.routers.whiteboard.rule=Host(`nextcloud.example.com`) && PathPrefix(`/whiteboard`)
- traefik.http.routers.whiteboard.middlewares=strip-whiteboard
```
</details>

## WebSocket Server Configuration

The websocket server handles real-time collaboration sessions (not critical whiteboard data):

### Collaboration Data Storage

**LRU Cache (Default)**
- In-memory session storage, simple setup
- Suitable for most deployments
- Session data cleared on restart (whiteboard data remains safe in Nextcloud/local storage)

```bash
STORAGE_STRATEGY=lru
```

**Redis**
- For multi-server setups or session persistence
- Enables horizontal scaling with Redis Streams

```bash
STORAGE_STRATEGY=redis
REDIS_URL=redis://[username:password@]host[:port][/database_number]
```

### Scaling (Optional)

For high-traffic environments with multiple websocket servers:

1. Use Redis for shared session state
2. Configure load balancer with session stickiness
3. Redis Streams handles WebSocket scaling automatically

## Troubleshooting

### Known Issues

**Legacy Integration App Conflict**
If you previously had `integration_whiteboard` installed, remove any whiteboard entries from `config/mimetypealiases.json` and run:
```bash
occ maintenance:mimetype:update-db
occ maintenance:mimetype:update-js
```

**Connection Issues**
- Verify JWT secrets match between Nextcloud and websocket server
- Check firewall rules allow communication between components
- Ensure reverse proxy correctly handles WebSocket upgrades

**Whiteboard ExApp Issues**

*Whiteboard Files Won't Open:*
- Check ExApp container is running: `docker ps | grep nextcloud_whiteboard`
- Verify auto-configuration: `occ config:app:get whiteboard collabBackendUrl`
- Look for JavaScript errors in browser console
- Test with a fresh `.whiteboard` file

*Real-time Collaboration Not Working:*
- Check network status indicator in whiteboard interface
- For DSP: Expect 1-2 second delay (polling mode)
- For HaRP: Should be near-instant (WebSocket mode)
- Verify JWT secret sync: `occ config:app:get whiteboard jwt_secret_key`

*Performance Issues:*
- DSP deployments have higher latency - this is expected
- Large whiteboards (>1000 elements) may need container resource limits adjustment
- Check container logs for memory/CPU warnings

*Auto-configuration Failures:*
- ExApp may fail to auto-configure on some setups
- Manually set: `occ config:app:set whiteboard collabBackendUrl --value="https://your-domain.com/exapps/nextcloud_whiteboard"`
- Restart ExApp container after manual configuration

## Development

To build the project locally:

```bash
npm ci
npm run build
```

For development with hot reload:
```bash
npm run watch
```

To run the websocket server in development:
```bash
npm run server:watch
```
