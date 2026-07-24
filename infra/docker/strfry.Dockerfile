# syntax=docker/dockerfile:1
#
# 1NKY strfry relay image.
#
# Why we don't just use ghcr.io/hoytech/strfry:latest directly:
#   That image exists and is actively rebuilt, but it is Alpine 3.18 + the
#   strfry binary and six shared libs — nothing else. `USER strfry`,
#   `WORKDIR /app`, `ENTRYPOINT ["/app/strfry"]`, `CMD ["relay"]`.
#   It ships no Node runtime, and strfry's write-policy plugin is spawned as a
#   stdio child process of the relay, inside this container. So the runtime the
#   plugin needs has to live here.
#
# This layer adds exactly one thing: nodejs. Nothing else changes — the
# entrypoint, user, workdir and db path are inherited untouched.
#
# Node version note: the base is Alpine 3.18, whose `nodejs` package is 18.x.
# infra/strfry/write-policy.mjs is written against Node 18 core APIs only (no
# dependencies, no fetch, no glob, no util.parseArgs) precisely so this is fine.
# The rest of the stack (apps/*) is Node 22 per CLAUDE.md — that pin applies to
# the workspace apps, not to this relay sidecar.
#
# If you want a newer Node here anyway, build with:
#   docker compose build --build-arg \
#     ALPINE_NODE_REPO=https://dl-cdn.alpinelinux.org/alpine/v3.21/main strfry

ARG STRFRY_IMAGE=ghcr.io/hoytech/strfry:latest
FROM ${STRFRY_IMAGE}

ARG ALPINE_NODE_REPO=""

USER root

RUN if [ -n "$ALPINE_NODE_REPO" ]; then \
        apk add --no-cache --repository="$ALPINE_NODE_REPO" nodejs; \
    else \
        apk add --no-cache nodejs; \
    fi \
 && rm -rf /var/cache/apk/* \
 && node --version

# The write policy + ban list are bind-mounted here by docker-compose.yml.
# Create the mountpoint so a missing bind mount fails loudly instead of
# silently producing an empty directory owned by root.
RUN mkdir -p /app/plugin && chown -R strfry:strfry /app/plugin

USER strfry

# strfry finds its config at /etc/strfry.conf (search order: --config,
# $STRFRY_CONFIG, /etc/strfry.conf, ./strfry.conf). compose mounts it there.
EXPOSE 7777
ENTRYPOINT ["/app/strfry"]
CMD ["relay"]
