<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Nextcloud Whiteboard

[![REUSE status](https://api.reuse.software/badge/github.com/nextcloud/whiteboard)](https://api.reuse.software/info/github.com/nextcloud/whiteboard)

The official whiteboard app for Nextcloud. It allows users to create and share whiteboards with other users and collaborate in real-time.

You can create whiteboards in the files app and share and collaborate on them.

## Features

- 🎨 Drawing shapes, writing text, connecting elements
- 📝 Real-time collaboration
- 💪 Strong foundation: We use [Excalidraw](https://github.com/excalidraw/excalidraw) as our base library

## Backend

### Standalone websocket server for Nextcloud Whiteboard

This is a standalone websocket server for the Nextcloud Whiteboard app. It is intended to be used as a standalone service that can be run in a container.

Both the server and the Nextcloud instance must be accessible from the same network and share a common secret key for JWT token generation.

On the Nextcloud side, the server must be configured through:

```bash
occ config:app:set whiteboard collabBackendUrl --value="http://nextcloud.local:3002"
occ config:app:set whiteboard jwt_secret_key --value="some-random"
```

#### Local node

This mode requires at least Node 20 and NPM 10 to be installed. You can clone this repository, checkout the release version matching your whiteboard app.
The server can be run locally using the following command:

```bash
npm ci
JWT_SECRET_KEY="some-random" NEXTCLOUD_URL=http://nextcloud.local npm run server:start
```

#### Docker

### Building the image

The image can be built using the following command:

```bash
docker build -t nextcloud-whiteboard-server
```

### Running the server

The server requires the `NEXTCLOUD_URL` environment variable to be set to the URL of the Nextcloud instance that the Whiteboard app is installed on. The server will connect to the Nextcloud instance and listen for whiteboard events.

The server can be run in a container using the following command:

```bash
docker run -e JWT_SECRET_KEY=some-random -e NEXTCLOUD_URL=https://nextcloud.local --restart unless-stopped -d ghcr.io/nextcloud-releases/whiteboard:release
```

Docker compose can also be used to run the server:

```yaml
version: '3.7'
services:
  nextcloud-whiteboard-server:
    image: ghcr.io/nextcloud-releases/whiteboard:release
    ports:
      - 3002:3002
    environment:
    environment:
      - NEXTCLOUD_URL=https://nextcloud.local
      - JWT_SECRET_KEY=some-random-key
      
```

### Reverse proxy

#### Apache

```
ProxyPass /whiteboard http://localhost:3002/
RewriteEngine on
RewriteCond %{HTTP:Upgrade} websocket [NC]
RewriteCond %{HTTP:Connection} upgrade [NC]
RewriteRule ^/?whiteboard/(.*) "ws://localhost:3002/$1" [P,L]
```

#### Nginx

```
location /whiteboard/ {
	proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
	proxy_set_header Host $host;
	
	proxy_pass http://localhost:3002;
	
	proxy_http_version 1.1;
	proxy_set_header Upgrade $http_upgrade;
	proxy_set_header Connection "upgrade";
}
```

### Known issues

If the [integration_whiteboard](https://github.com/nextcloud/integration_whiteboard) app was previously installed there might be a leftover non-standard mimetype configured. In this case opening the whiteboard may fail and a file is downloaded instead. Make sure to remove any entry in config/mimetypealiases.json mentioning whiteboard and run `occ maintenance:mimetype:update-db` and `occ maintenance:mimetype:update-js`.
