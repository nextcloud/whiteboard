# syntax=docker/dockerfile:latest
# SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

FROM node:23.6.1-alpine AS build
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]
ARG NODE_ENV=production
COPY . /app
WORKDIR /app
RUN apk upgrade --no-cache -a && \
    apk add --no-cache ca-certificates && \
    npm install --global clean-modules && \
    npm clean-install && \
    clean-modules --yes && \
    npm cache clean --force

FROM node:23.6.1-alpine
COPY --from=build --chown=nobody:nobody /app /app
WORKDIR /app
RUN apk upgrade --no-cache -a && \
    apk add --no-cache ca-certificates tzdata netcat-openbsd
USER nobody
EXPOSE 3002
ENTRYPOINT ["npm", "run", "server:start"]
HEALTHCHECK CMD nc -z 127.0.0.1 3002 || exit 1
