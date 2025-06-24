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
- 🌐 Works semi-offline - changes saved locally and synced when online (websocker server configured successfully)
- 💪 Built on [Excalidraw](https://github.com/excalidraw/excalidraw)

## Architecture

Nextcloud Whiteboard uses a **client-first architecture** that prioritizes browser-based functionality:

- **Browser-First**: All whiteboard functionality works directly in the browser
- **Local Storage**: Changes are immediately saved to browser storage (IndexedDB)
- **Real-time Collaboration**: WebSocket server handles live collaboration sessions
- **Simplified Connectivity**: Only browsers need to connect to the websocket server
- **Reduced Dependencies**: Websocket server is only needed for real-time collaboration, not basic functionality

## Installation & Setup

### WebSocket Server for Real-time Collaboration

The websocket server handles real-time collaboration sessions between users. **Important**: The websocket server is only needed for live collaboration - basic whiteboard functionality works without it.

#### Connectivity Requirements

**Essential (for real-time collaboration):**
- User browsers need HTTP(S) access to the websocket server
- Nextcloud and websocket server share a JWT secret for authentication

#### Configuration

Configure Nextcloud with the websocket server details: (Can be configured in the Nextcloud admin settings)

```bash
occ config:app:set whiteboard collabBackendUrl --value="https://nextcloud.local:3002"
occ config:app:set whiteboard jwt_secret_key --value="some-random-secret"
```

### Running the WebSocket Server

#### Node.js

```bash
npm ci
JWT_SECRET_KEY="some-random-secret" NEXTCLOUD_URL=https://nextcloud.local npm run server:start
```

#### Docker

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

**Environment Variables:**
- `JWT_SECRET_KEY`: Must match the secret configured in Nextcloud
- `NEXTCLOUD_URL`: Used for JWT token validation (not for server-to-server communication)

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

### Connection Issues

**Real-time Collaboration Not Working**
- Verify JWT secrets match between Nextcloud and websocket server
- Check that user browsers can access the websocket server URL
- Ensure reverse proxy correctly handles WebSocket upgrades
- Check browser console for connection errors

### Known Issues

**Legacy Integration App Conflict**
If you previously had `integration_whiteboard` installed, remove any whiteboard entries from `config/mimetypealiases.json` and run:
```bash
occ maintenance:mimetype:update-db
occ maintenance:mimetype:update-js
```

**Misleading Admin Errors**
Admin connectivity checks may show false negatives in Docker/proxy environments. These errors don't affect actual functionality since the architecture is client-first. Focus on browser-based connectivity tests instead.

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
