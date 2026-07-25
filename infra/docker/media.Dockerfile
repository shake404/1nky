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

# ffmpeg is required for the video upload path: every clip is transcoded
# through ffmpeg with all metadata stripped (GPS/device) before the bytes are
# stored. ffprobe probes the output for duration + dimensions. Installed in the
# runtime stage (the image that runs node) as root, before dropping to `node`.
# --no-install-recommends keeps the layer small; ffmpeg brings its own deps.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /repo /repo

USER node
EXPOSE 3002

# Re-encodes every image upload with sharp as defense-in-depth (hard rule #5)
# and streams to R2. Video uploads are transcoded through ffmpeg to a temp file
# (cleaned up in a finally block) and never persisted as the original bytes, so
# no tmpdir volume is mounted on purpose — the OS tmpdir is enough and is not
# retained.
CMD ["node", "apps/media/dist/index.js"]
