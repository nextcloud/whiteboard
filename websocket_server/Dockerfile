# syntax=docker/dockerfile:latest
# SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

### Build Stage ###
FROM node:23.11.1-alpine3.21 AS build

ENV NODE_ENV=production
WORKDIR /app
COPY . .

RUN apk add --no-cache python3 make g++ \
    && npm clean-install \
    && apk del python3 make g++

### Runtime Stage ###
FROM node:23.11.1-alpine3.21

# Install frp for HaRP integration
RUN apk add --no-cache bash frp

# Copy start.sh and application
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh
COPY --from=build /app /app
WORKDIR /app

# Entrypoint
ENTRYPOINT ["/usr/local/bin/start.sh"]