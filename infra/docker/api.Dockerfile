# syntax=docker/dockerfile:1
#
# @1nky/api — read-only REST API. Listens on :3001.
#
# Build context is the REPO ROOT (see docker-compose.yml), because pnpm
# workspaces need pnpm-workspace.yaml + the lockfile + every workspace package
# present in order to resolve `workspace:*` links to @1nky/protocol.
#
#   docker compose --profile full build api
#
# Before pnpm-lock.yaml is committed:
#   PNPM_INSTALL_FLAGS=--no-frozen-lockfile docker compose --profile full build api
#
# NOTE FOR THE ORCHESTRATOR: this repo has no root .dockerignore, and creating
# one is a root-file change that infra/ is not allowed to make. Without it the
# build context includes node_modules/, .git/ and apps/web/dist/, which makes
# every build slow. Recommended root .dockerignore:
#     node_modules
#     **/node_modules
#     **/dist
#     **/.turbo
#     .git
#     infra/scripts/node_modules

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

# Workspace manifests first so dependency installs cache independently of
# source edits. pnpm-lock.yaml* is a glob: it does not fail when absent.
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY pnpm-lock.yaml* ./

# pnpm needs the real package.json of every workspace member to build its
# lockfile graph, so copy the whole tree. Fine-grained manifest copying is a
# false economy in a repo this size.
COPY packages ./packages
COPY apps ./apps

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install ${PNPM_INSTALL_FLAGS}

# `@1nky/api...` (with the trailing ellipsis) builds @1nky/api *and* its
# workspace dependencies — i.e. @1nky/protocol — in topological order.
RUN pnpm --filter "@1nky/api..." build

# --- runtime -----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    API_PORT=3001

# Copy the built workspace wholesale. Keeps the Dockerfile honest and avoids
# `pnpm deploy`, whose semantics changed across pnpm 9/10. If image size ever
# matters, that is the optimisation to reach for, not hand-pruning node_modules.
COPY --from=build --chown=node:node /repo /repo

USER node
EXPOSE 3001

# Express 5. No morgan, no access-log middleware — hard rule #1.
CMD ["node", "apps/api/dist/index.js"]
