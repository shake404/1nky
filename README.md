# 1NKY

**Anonymous, registration-free community platform for graffiti writers.**
Post flicks. Talk beef. Rep your city. No accounts, no emails, no logs —
your identity is a cryptographic tag only you hold.

- Transparency, privacy posture & responsible disclosure: **docs.1nky.com**
  (source in `apps/docs`)
- Verify what the live site serves: [docs.1nky.com/privacy/verify](https://docs.1nky.com/privacy/verify)
- Build rules: [CLAUDE.md](CLAUDE.md)

## Architecture (short version)

Signed events (Nostr data model, invisible to users) → self-hosted strfry
relay (source of truth) → Postgres indexer (rebuildable cache) → read-only
REST API → React PWA. Media is content-addressed (SHA-256) on S3-compatible
storage behind a Blossom-compatible service. The server architecturally
cannot identify users: there is nothing to scour and nothing to subpoena.

## Workspaces

| Path | What |
|---|---|
| `apps/web` | React 18 + Vite PWA — the site |
| `apps/api` | Read-only REST API (feeds, search, mod queue) |
| `apps/indexer` | Relay firehose → Postgres |
| `apps/media` | Blossom-compatible media service (BUD-01/02) |
| `apps/docs` | Public docs: transparency, roadmap, feedback |
| `packages/protocol` | Shared event helpers, kinds, PoW, blackbook |
| `infra/` | docker-compose, strfry, Caddy, write-policy, deploy |

## Dev

```sh
pnpm install
pnpm dev          # all services
docker compose -f infra/docker-compose.yml up   # relay + db + full stack
```
