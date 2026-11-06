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
- 🌐 Works semi-offline - changes saved locally and synced when online (websocket server configured successfully)
- 💪 Built on [Excalidraw](https://github.com/excalidraw/excalidraw)

## Architecture

Nextcloud Whiteboard uses a **client-first architecture** that prioritizes browser-based functionality:

- **Browser-First**: The editor runs in the browser and saves to Nextcloud directly
- **Local Storage**: Changes are immediately saved to browser storage (IndexedDB)
- **Saving**: WebSocket server picks the browser that saves each board to Nextcloud, also when only one person edits it
- **Real-time Collaboration**: WebSocket server handles live collaboration sessions
- **Simplified Connectivity**: Only browsers need to connect to the websocket server

## Installation & Setup

Whiteboard has two parts, and a working setup needs both:

1. The **Whiteboard app**, installed in Nextcloud.
2. The **collaboration server**, also called the websocket server: a separate Node.js service that the browsers of your users connect to.

### Installing the Whiteboard app

Install and enable the app from the Nextcloud App Store in Apps, or with occ:

```bash
occ app:install whiteboard
```

With the app alone, users can create and open boards, but their changes are not saved to Nextcloud. Set up the collaboration server next.

<a id="websocket-server-for-real-time-collaboration"></a>

### WebSocket Server

The websocket server handles real-time collaboration sessions between users. **Important**: The websocket server is required, also when only one person edits a board. It decides which browser saves each board to Nextcloud, so without it changes stay in the browser and are not saved to Nextcloud. A websocket server deployment, with one or more nodes, serves a single Nextcloud instance.

**Environment Variables:**
The websocket server reads these environment variables at startup:

| Name | Default | Description |
|---|---|---|
| `CACHED_TOKEN_TTL` | `600000` (10 minutes) | Time in milliseconds that the server caches a verified token |
| `CHROME_EXECUTABLE_PATH` | Found in the usual install locations | Path of the Chrome or Chromium binary used for recordings |
| `CLEANUP_LOCAL_RECORDINGS` | `false` | Delete the local recording file after it is uploaded |
| `COMPRESSION_ENABLED` | `true` | Per-message deflate compression for WebSocket messages |
| `FORCE_CLOSE_TIMEOUT` | `3600000` (1 hour) | Time in milliseconds the server waits for connections to close on shutdown before it stops anyway |
| `HOST` | `0.0.0.0` | Interface the server listens on |
| `JWT_SECRET_KEY` | none, required | Must match the secret configured in Nextcloud |
| `JWT_SECRET_KEY_FILE` | none | Path of a file holding the secret, instead of `JWT_SECRET_KEY`, for example a Docker secret in `/run/secrets/` |
| `MAX_UPLOAD_FILE_SIZE` | `2` | Largest file in megabytes that users can add to a board |
| `METRICS_TOKEN` | none | Enables the Prometheus metrics at `/metrics`, with this token as a Bearer token or as the `?token=` parameter |
| `NEXTCLOUD_URL` | `http://nextcloud.local` | URL of your Nextcloud. Recordings open and upload boards there, and HTTP requests from browsers, such as the status check of the admin settings, are allowed only from this origin |
| `PORT` | `3002` | Port the server listens on |
| `RECORDINGS_DIR` | `/tmp/whiteboard-recordings` in the Docker image | Writable directory for temporary recording files; falls back to the OS temp directory if it is not writable |
| `RECORDING_DISCONNECT_GRACE_MS` | `5000` | Time in milliseconds before a recording stops after the recorder disconnects |
| `RECORDING_ENABLED` | `true` | Set to `false` on every node to turn recording off: the server never starts Chromium and boards show no recording item |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL when `STORAGE_STRATEGY` is `redis`, in the form `redis://[username:password@]host[:port][/database_number]` |
| `SESSION_TTL` | `86400000` (24 hours) | Time in milliseconds that collaboration data of a session, such as timers and votings, is kept |
| `STORAGE_STRATEGY` | `lru` | `lru` keeps collaboration data in memory. `redis` keeps it in Redis and is required for more than one node |
| `TLS` | `false` | Serve HTTPS instead of HTTP. A reverse proxy is recommended for production |
| `TLS_CERT` | none | Path of the certificate file when `TLS` is `true` |
| `TLS_KEY` | none | Path of the private key file when `TLS` is `true` |

#### Connectivity Requirements

**Essential:**
- User browsers need HTTP(S) access to the websocket server
- Nextcloud and websocket server share a JWT secret for authentication

#### Configuration

Enter the URL of the websocket server and the shared secret in Administration settings > Whiteboard, or set them with occ:

```bash
occ config:app:set whiteboard collabBackendUrl --value="https://nextcloud.example.com/whiteboard"
occ config:app:set whiteboard jwt_secret_key --type=string --value="some-random-secret" --no-interaction
```

Without `--no-interaction`, Nextcloud 36 asks you to confirm the secret by typing `yes`.

The app reads these settings, set with `occ config:app:set whiteboard <key>`:

| Key | Default | Description |
|---|---|---|
| `collabBackendUrl` | none | URL of the websocket server as the browsers reach it, for example through the [reverse proxy](#reverse-proxy-configuration) |
| `jwt_secret_key` | none | Must match `JWT_SECRET_KEY` of the websocket server |
| `max_file_size` | `10` | Largest image in megabytes that users can add to a board, measured on the original file. Images must also fit `MAX_UPLOAD_FILE_SIZE` of the websocket server, or the board refuses them. Set it with `--type=integer` |
| `disable_external_libraries` | `false` | Set to `true` with `--type=boolean` to hide the button that browses the public Excalidraw libraries |

#### Managed hosting

If a provider hosts your Nextcloud, ask them whether they run the websocket server for Whiteboard. If they do not, you can run it on any machine that the browsers of your users reach over HTTPS, for example with the Docker image below, with `NEXTCLOUD_URL` set to the URL of your Nextcloud. Then enter its URL and secret in Administration settings > Whiteboard, or ask your provider to do it if you are not an administrator. The websocket server needs to reach your Nextcloud only for recordings.

### Running the WebSocket Server

#### Node.js

```bash
npm ci
JWT_SECRET_KEY="some-random-secret" NEXTCLOUD_URL=https://nextcloud.local npm run server:start
```

#### Docker

```bash
docker run -e JWT_SECRET_KEY=some-random-secret -e NEXTCLOUD_URL=https://nextcloud.local -p 3002:3002 --rm ghcr.io/nextcloud-releases/whiteboard:stable
```

Or using Docker Compose:

```yaml
services:
  nextcloud-whiteboard-server:
    image: ghcr.io/nextcloud-releases/whiteboard:stable
    ports:
      - "3002:3002"
    environment:
      NEXTCLOUD_URL: https://nextcloud.local
      JWT_SECRET_KEY: some-random-secret
```

The [environment variables](#websocket-server) above apply to both.

### Recording prerequisites

Board recordings require a headless Chromium browser and [ffmpeg](https://ffmpeg.org/) on the `PATH` of the collaboration server. If you do not want recordings, set `RECORDING_ENABLED=false` on every node of the collaboration server: it then never starts Chromium and boards show no recording item. The system automatically detects Chrome installations:

- **Self-hosted**: Auto-detects Chrome/Chromium in standard locations
- **Docker**: Uses bundled Alpine Chromium package
- **Custom paths**: Set `CHROME_EXECUTABLE_PATH` environment variable

**Quick Setup**

**Docker (Recommended)**
```bash
# No setup needed - Chromium is pre-installed
docker run -e JWT_SECRET_KEY=some-random-secret -p 3002:3002 --rm ghcr.io/nextcloud-releases/whiteboard:stable
```

**Self-hosted Systems**
```bash
# Debian
sudo apt-get update
sudo apt-get install -y chromium

# Ubuntu (Chromium is only available as a snap)
sudo snap install chromium

# Alpine Linux  
apk add --no-cache chromium nss freetype harfbuzz ttf-freefont

# macOS (install Chrome via Homebrew or download from google.com/chrome)
brew install --cask google-chrome

# Verify installation
chromium --version          # Debian, Ubuntu
chromium-browser --version  # Alpine
google-chrome --version     # macOS/Chrome
```

**Advanced Configuration**
```bash
# Override auto-detection (for custom Chrome locations)
export CHROME_EXECUTABLE_PATH="/path/to/your/chrome"
npm run server:start
```

With recording on, the server checks for Chrome when a board connects and before each recording. If Chrome isn't found, users receive clear error messages with installation guidance. Temporary recording data is written to the directory specified by `RECORDINGS_DIR` (or `/tmp/whiteboard-recordings` in the official Docker image). If that location cannot be created or written, the server falls back to the operating system temp directory automatically and logs a warning. After installing Chrome, restart the websocket server to apply changes.

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
2. Redis Streams handles WebSocket scaling automatically; clients connect over WebSocket only, so the load balancer needs no session stickiness
3. Redis is required for multi-node clusters; socket and room session keys use TTLs instead of global clears so restarting a node does not erase active state on its peers

## Benchmarking & Capacity Planning

To size dedicated collaboration servers we profiled the websocket backend with the synthetic load harness in `tools/benchmarks/`. The `runBenchmarks.mjs` script boots the production server (TLS disabled, LRU cache) and spawns JWT-authenticated Socket.IO clients from `loadTest.mjs`. Each run holds a room open for 60 seconds, with 10% of participants sending cursor and viewport updates at 2 Hz to mimic active sketching while the rest stay idle.

**Test environment**
- Apple M4 (10 logical cores, 16 GB RAM), Node v24.8.0
- Single websocket process, `NODE_OPTIONS=--max-old-space-size=8192`, `STORAGE_STRATEGY=lru`
- Aggregate ingress/egress recorded from client telemetry (`nettop` requires root on macOS)
- Full JSON results are stored in `tools/benchmarks/results.json`

**Observed highlights**
- Per-user CPU hovered around 0.2% for small teams and climbed to ~0.37% at 300 concurrent users.
- Memory footprint stayed near 5 MB/user at 50 users and ~10 MB/user at 300 users.
- Server egress reached ~3 Mbps (50 users), ~13 Mbps (100 users) and ~366 Mbps (300 users). Pushing to 500 synthetic users drove ~1.2 Gbps and the single process began dropping ~30% of sockets.

**Key takeaways**
- Expect roughly 0.2% CPU per connected collaborator; reserve additional headroom for presenters or rapid drawing.
- Budget ~5–10 MB of process RSS per user when running in a single-node, in-memory configuration.
- Throughput scales quickly with active senders—plan outbound bandwidth over-provisioning (≥15 Mbps / 100 users) when presentations or screen follow are frequent.

| Concurrent users | Avg CPU (10-core test rig) | Avg RSS | Server egress (60 s run) | Recommended spec |
| --- | --- | --- | --- | --- |
| 50 | ~10% (~0.21% per user) | ~0.24 GB | ~23.5 MB total (≈3.1 Mbps) | 2 vCPU / 1 GB RAM |
| 100 | ~20% (~0.20% per user) | ~0.36 GB | ~96.6 MB total (≈12.9 Mbps) | 4 vCPU / 2 GB RAM |
| 500* | ~203% (≈2 cores) | ~3.6–4.5 GB | ~9.2 GB total (≈1.2 Gbps) | ≥8 vCPU / ≥8 GB RAM per node + Redis + ≥2 nodes |

\*500-user test saturated a single instance and dropped ~30% of simulated clients. Treat this as an upper bound and plan to run multiple websocket workers behind a load balancer with `STORAGE_STRATEGY=redis`.

### Run the benchmark locally

1. Install dependencies: `npm ci` (and `composer install` if you have not bootstrapped the PHP side yet).
2. Ensure the websocket server can start without TLS (set `TLS=false` or export `TLS=false` before running the script) and that `JWT_SECRET_KEY`/`NEXTCLOUD_URL` are configured for your environment.
3. Execute `node tools/benchmarks/runBenchmarks.mjs` to run the default scenarios (50, 100, 300 concurrent users).
4. Adjust load with environment variables as needed:
   - `LOAD_TEST_CONCURRENCY=50,150,300` to pick specific cohorts (comma separated).
   - `LOAD_TEST_ACTIVE_RATIO=0.15` to vary the percentage of active broadcasters.
   - `LOAD_TEST_RATE=3` to control per-sender update frequency (messages/sec).
   - `LOAD_TEST_DURATION=90` to lengthen each run.
5. After each execution the summarized telemetry is printed to stdout and saved to `tools/benchmarks/results.json`; keep copies per hardware profile for future comparisons.
6. When testing in prod-like environments, monitor OS-level CPU/RAM/network metrics in parallel (e.g., `top`, `sar`, cloud dashboards) to validate the Node-level sampling.

**Recommendations**
- Keep `NODE_OPTIONS=--max-old-space-size=8192` (or higher) when targeting 300+ concurrent users to avoid heap exhaustion.
- For 300+ users, switch to Redis-backed storage and deploy at least two websocket instances to spread load.
- Budget at least 15 Mbps outbound bandwidth for every 100 concurrently connected users; architecturally heavy sessions (live presenting, rapid drawing) can double that figure.
- Re-run `node tools/benchmarks/runBenchmarks.mjs` after feature changes or on target hardware to validate sizing before production rollout.

## Troubleshooting

### Connection Issues

**Boards Not Saved or Real-time Collaboration Not Working**
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
The admin connectivity check connects from your browser in the same way the editor does. If it fails, check the websocket server URL, the reverse proxy and the browser console. Boards are saved to Nextcloud only while the editor is connected to the websocket server.

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

### Building with a local Excalidraw

Whiteboard uses [`@nextcloud/excalidraw`](https://www.npmjs.com/package/@nextcloud/excalidraw), built from our fork [nextcloud-deps/excalidraw](https://github.com/nextcloud-deps/excalidraw). Whiteboard 3 uses the fork's branch `release-base-2026-10`, not `master`.

To try a change of the fork in Whiteboard, build and pack the fork's packages, then install them into Whiteboard without changing `package.json`. You need the Node.js and npm versions of Whiteboard's `package.json` and yarn 1, for example through `corepack enable`. Run these commands in the directory that contains your Whiteboard checkout, named `whiteboard`:

```bash
git clone --branch release-base-2026-10 https://github.com/nextcloud-deps/excalidraw.git
cd excalidraw
yarn release --tag=whiteboard-3 --pack=../excalidraw-packages

cd ../whiteboard
npm ci
npm install --no-save ../excalidraw-packages/*.tgz
npm run dev
```

The release script installs the fork's dependencies, builds the packages and packs them into `excalidraw-packages`. While these packages are installed, `npm ls` calls them invalid, because `package.json` pins the published version. Run `npm ci` in Whiteboard to go back to it.

### Releasing the Excalidraw fork

Every push to `release-base-2026-10` runs the fork's `autorelease-excalidraw.yml` workflow. It publishes the packages to npm with the version in `packages/excalidraw/package.json` and the dist-tag `whiteboard-3`, and skips versions that are already published. To release, merge a pull request into that branch that raises the version of the five packages that `scripts/release.js` publishes, and of their dependencies on each other, as [nextcloud-deps/excalidraw#30](https://github.com/nextcloud-deps/excalidraw/pull/30) did from `0.18.0-nc.1` to `0.18.0-nc.2`. Then update `@nextcloud/excalidraw` in Whiteboard in a separate pull request.
