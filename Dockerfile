# syntax=docker/dockerfile:latest
# SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

FROM node:25.0.0-alpine AS build
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]
ARG NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=1
WORKDIR /app
COPY package*.json ./
RUN npm install --global clean-modules && \
    npm clean-install && \
    clean-modules --yes && \
    npm cache clean --force
COPY . .

FROM node:25.0.0-alpine
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/app \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    CHROME_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    XDG_RUNTIME_DIR=/tmp/chromium-runtime \
    CRASHPAD_DATABASE=/tmp/chrome-crashpad \
    RECORDINGS_DIR=/tmp/whiteboard-recordings \
    CHROME_OPTIONS="--max-old-space-size=2048 --no-sandbox"
RUN apk add --no-cache \
        ca-certificates \
        netcat-openbsd \
        chromium \
        nss \
        freetype \
        harfbuzz \
        ttf-freefont && \
    chromium-browser --version && \
    install -d -m 0700 -o nobody -g nobody /tmp/chromium-runtime /tmp/chrome-crashpad /tmp/whiteboard-recordings && \
    mv /usr/lib/chromium/chrome_crashpad_handler /usr/lib/chromium/chrome_crashpad_handler.real && \
    printf '%s\n' '#!/bin/sh' 'exec /usr/lib/chromium/chrome_crashpad_handler.real --no-periodic-tasks --database="${CRASHPAD_DATABASE:-/tmp/chrome-crashpad}" "$@"' >/usr/lib/chromium/chrome_crashpad_handler && \
    chmod +x /usr/lib/chromium/chrome_crashpad_handler
COPY --from=build --chown=nobody:nobody /app /app
USER nobody
EXPOSE 3002
ENTRYPOINT ["npm", "run", "server:start"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"
