# syntax=docker/dockerfile:1
#
# @1nky/media — Blossom-compatible media service. Listens on :3002.
#
# Build context is the REPO ROOT (see docker-compose.yml).
#   docker compose --profile full build media
#
# sharp: node:22-bookworm-slim is glibc/x64|arm64, so sharp's prebuilt libvips
# binaries install cleanly and no build toolchain is needed. If you ever swap
# the base to Alpine you must add `libc6-compat vips-dev` and expect a source
# build. Don't.

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

RUN pnpm --filter "@1nky/media..." build

# --- runtime -----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    MEDIA_PORT=3002

COPY --from=build --chown=node:node /repo /repo

USER node
EXPOSE 3002

# Re-encodes every upload with sharp as defense-in-depth (hard rule #5) and
# streams to R2. Original bytes are never persisted; nothing is written to
# local disk, so no tmpdir volume is mounted on purpose.
CMD ["node", "apps/media/dist/index.js"]
