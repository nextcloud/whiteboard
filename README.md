<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Nextcloud Whiteboard

[![REUSE status](https://api.reuse.software/badge/github.com/nextcloud/whiteboard)](https://api.reuse.software/info/github.com/nextcloud/whiteboard)

This is a whiteboard app for Nextcloud. It allows users to create and share whiteboards with other users and collaborate in real-time.

## Features

- 🎨 Drawing shapes, writing text, connecting elements
- 📝 Real-time collaboration
- 💪 Strong foundation: We use [excalidraw](https://github.com/excalidraw/excalidraw) as our base library

## Backend

### Standalone websocket server for Nextcloud Whiteboard

This is a standalone websocket server for the Nextcloud Whiteboard app. It is intended to be used as a standalone service that can be run in a container.

Both the server and the Nextcloud instance must be accessible from the same network and share a common secret key for JWT token generation.

On the Nextcloud side, the server must be configured through:

```bash
occ config:app:set whiteboard collabBackendUrl --value="nextcloud.local:3003"
occ config:app:set whiteboard jwt_secret_key --value="some-random"
```

#### Local node

The server can be run locally using the following command:

```bash
npm ci
npm server:start
```

#### Docker

### Building the image

The image can be built using the following command:

```bash
docker build -t nextcloud-whiteboard-server -f Dockerfile ../
```

### Running the server

The server requires the `NEXTCLOUD_URL` environment variable to be set to the URL of the Nextcloud instance that the Whiteboard app is installed on. The server will connect to the Nextcloud instance and listen for whiteboard events.

The server can be run in a container using the following command:

```bash
docker run -e JWT_SECRET_KEY=some-random -e NEXTCLOUD_URL=https://nextcloud.local --rm nextcloud-whiteboard-server
```

Docker compose can also be used to run the server:

```yaml
version: '3.7'
services:
  nextcloud-whiteboard-server:
    image: nextcloud-whiteboard-server
    ports:
      - 3002:3002
    environment:
      - NEXTCLOUD_URL=https://nextcloud.local
      - JWT_SECRET_KEY=some-random-key
      
```

### Reverse proxy

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
