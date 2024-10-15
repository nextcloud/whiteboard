# syntax=docker/dockerfile:latest
# SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

FROM node:22.9.0-alpine3.20 AS build
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]
ARG NODE_ENV=production
COPY ./ /app
WORKDIR /app
RUN apk upgrade --no-cache -a && \
    apk add --no-cache ca-certificates && \
    npm install --global clean-modules && \
    npm clean-install && \
    clean-modules --yes && \
    npm cache clean --force

FROM node:22.9.0-alpine3.20
COPY --from=build --chown=nobody:nobody /app /app
WORKDIR /app
RUN apk upgrade --no-cache -a && \
    apk add --no-cache ca-certificates tzdata netcat-openbsd curl

ENV PORT=23000
ENV TLS=false
ENV STORAGE_STRATEGY=lru
ENV SETUP_TYPE=ex_app
ENV NEXTCLOUD_EX_APP_URL=http://nextcloud

USER nobody
EXPOSE 23000
ENTRYPOINT ["npm", "run", "start"]
HEALTHCHECK CMD nc -z 127.0.0.1 23000 || exit 1
