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

Running the whiteboard server is required for the whiteboard to work. The server will handle real-time collaboration events and broadcast them to all connected clients, which means that the server must be accessible from the users browser, so exposing it for example throuhg a reverse proxy is necessary. It is intended to be used as a standalone service that can be run in a container.

We require the following connectivity:

- The whiteboard server needs to be able to reach the Nextcloud server over HTTP(S)
- The Nextcloud server needs to be able to reach the whiteboard server over HTTP(S)
- The user's browser needs to be able to reach the whiteboard server over HTTP(S) in the browser
- Nextcloud and the whiteboard server share a secret key to sign and verify JWTs

On the Nextcloud side, the server must be configured through:

```bash
occ config:app:set whiteboard collabBackendUrl --value="http://nextcloud.local:3002"
occ config:app:set whiteboard jwt_secret_key --value="some-random"
```

### Running the server

#### Local node

This mode requires at least Node 20 and NPM 10 to be installed. You can clone this repository, checkout the release version matching your whiteboard app.
The server can be run locally using the following command:

```bash
npm ci
JWT_SECRET_KEY="some-random" NEXTCLOUD_URL=http://nextcloud.local npm run server:start
```

#### Docker

The server requires the `NEXTCLOUD_URL` environment variable to be set to the URL of the Nextcloud instance that the Whiteboard app is installed on. The server will connect to the Nextcloud instance and listen for whiteboard events.

The server can be run in a container using the following command:

```bash
docker run -e JWT_SECRET_KEY=some-random -e NEXTCLOUD_URL=https://nextcloud.local --rm ghcr.io/nextcloud-releases/whiteboard:release
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
      - NEXTCLOUD_URL=https://nextcloud.local
      - JWT_SECRET_KEY=some-random-key
      
```

#### Building the image locally

While we publish image on the GitHub container registry you can build the image locally using the following command:

```bash
docker build -t nextcloud-whiteboard-server -f Dockerfile .
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
	
	proxy_pass http://localhost:3002/;
	
	proxy_http_version 1.1;
	proxy_set_header Upgrade $http_upgrade;
	proxy_set_header Connection "upgrade";
}
```

#### Caddy v2

```
handle_path /whiteboard/* {
    reverse_proxy http://127.0.0.1:3002
}
```

## Storage Strategies and Scaling

The whiteboard application supports two storage strategies: LRU (Least Recently Used) cache and Redis. Each strategy has its own characteristics and is suitable for different deployment scenarios.

### Storage Strategies

#### 1. LRU (Least Recently Used) Cache

The LRU cache strategy is an in-memory storage solution that keeps the most recently used items in memory while automatically removing the least recently used items when the cache reaches its capacity.

**Advantages:**
- Simple setup with no additional infrastructure required
- Fast read and write operations
- Suitable for single-node deployments

**Limitations:**
- Limited by available memory on the server
- Data is not persistent across server restarts
- Not suitable for multi-node deployments

**Configuration:**
To use the LRU cache strategy, set the following in your `.env` file:

```
STORAGE_STRATEGY=lru
```

**Resources:**
- [LRU Cache in Node.js](https://www.npmjs.com/package/lru-cache)

#### 2. Redis

Redis is an in-memory data structure store that can be used as a database, cache, and message broker. It provides persistence and supports distributed setups.

**Advantages:**
- Persistent storage
- Supports multi-node deployments
- Allows for horizontal scaling

**Limitations:**
- Requires additional infrastructure setup and maintenance
- Slightly higher latency compared to LRU cache for single-node setups

**Configuration:**
To use the Redis strategy, set the following in your `.env` file:

```
STORAGE_STRATEGY=redis
REDIS_URL=redis://[username:password@]host[:port][/database_number]
```

Replace the `REDIS_URL` with your actual Redis server details.

### Scaling and Deployment

#### Single-Node Deployment

For small to medium-sized deployments, a single-node setup can be sufficient:

1. Choose either LRU or Redis strategy based on your persistence needs.
2. Configure the `.env` file with the appropriate `STORAGE_STRATEGY`.
3. If using Redis, ensure the Redis server is accessible and configure the `REDIS_URL`.
4. Start the whiteboard server.

#### Multi-Node Deployment (Clustered Setup)

For larger deployments requiring high availability and scalability, a multi-node setup is recommended:

1. Use the Redis storage strategy.
2. Set up a Redis cluster or a managed Redis service.
3. Configure each node's `.env` file with:
   ```
   STORAGE_STRATEGY=redis
   REDIS_URL=redis://[username:password@]host[:port][/database_number]
   ```
4. Set up a load balancer to distribute traffic across the nodes.
5. Ensure all nodes can access the same Redis instance or cluster.

#### Scaling WebSocket Connections

The whiteboard application uses the Redis Streams adapter for scaling WebSocket connections across multiple nodes. This adapter leverages Redis Streams, not the Redis Pub/Sub mechanism, for improved performance and scalability.

When using the Redis strategy, the application automatically sets up the Redis Streams adapter for WebSocket scaling. This allows multiple server instances to share WebSocket connections and real-time updates.

**Resources:**
- [Socket.IO Redis Streams Adapter](https://socket.io/docs/v4/redis-streams-adapter/)

#### Considerations for Multi-Node Setups

- **Load Balancing:** Set up a load balancer to distribute incoming connections across your server nodes.
- **Session Stickiness:** While not strictly required for WebSocket transport, it's recommended to configure your load balancer to use session stickiness. This ensures that requests from a client are routed to the same server for the duration of a session, which can be beneficial if falling back to long polling.
- **WebSocket Support:** Ensure your load balancer is configured to support WebSocket connections and maintain long-lived connections.
- **Redis Setup:** The current implementation does not configure Redis Cluster. So if you need to use a Redis Cluster for high availability, you'll need to set up your own load balancer in front of your Redis Cluster nodes.
- **Redis Connection:** The application currently supports only one Redis connection for both the storage layer and streaming/scaling the WebSocket server.
- **Redis Persistence:** Configure Redis with appropriate persistence settings (e.g., RDB snapshots or AOF logs) to prevent data loss in case of Redis server restarts.
- **Monitoring:** Implement monitoring for both your application nodes and Redis servers to quickly identify and respond to issues.

### Choosing the Right Strategy

- **LRU Cache:** Ideal for small deployments, development environments, or scenarios where data persistence across restarts is not critical.
- **Redis:** Recommended for production environments, especially when scaling horizontally or when data persistence is required.

By carefully considering your deployment needs and choosing the appropriate storage strategy, you can ensure optimal performance and scalability for your whiteboard application.

### Known issues

If the [integration_whiteboard](https://github.com/nextcloud/integration_whiteboard) app was previously installed there might be a leftover non-standard mimetype configured. In this case opening the whiteboard may fail and a file is downloaded instead. Make sure to remove any entry in config/mimetypealiases.json mentioning whiteboard and run `occ maintenance:mimetype:update-db` and `occ maintenance:mimetype:update-js`.
