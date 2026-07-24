# syntax=docker/dockerfile:1
#
# @1nky/indexer — subscribes to the strfry firehose and upserts into Postgres.
# No listening port: it is a consumer, not a server.
#
# Postgres is a rebuildable cache; the relay is the source of truth. This
# process can be wiped and replayed at any time.
#
# Build context is the REPO ROOT (see docker-compose.yml).
#   docker compose --profile full build indexer

ARG NODE_VERSION=22

# --- base --------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI=1
RUN corepack enable
WORKDIR /repo

# --- build -------------------------------------------------------------------
FROM base AS build
ARG PNPM_INSTALL_FLAGS=--frozen-lockfile

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY pnpm-lock.yaml* ./
COPY packages ./packages
COPY apps ./apps

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install ${PNPM_INSTALL_FLAGS}

RUN pnpm --filter "@1nky/indexer..." build

# --- runtime -----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=build --chown=node:node /repo /repo

USER node

# The indexer's schema has no IP column and never will (hard rule #1).
CMD ["node", "apps/indexer/dist/index.js"]
