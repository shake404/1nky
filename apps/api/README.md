# `@1nky/api`

Read-only REST over the Postgres index. Express 5, `pg`, nothing else.

**There are no write endpoints and there will never be any.** Writes to 1NKY
are signed events published to the relay (CLAUDE.md hard rule #4). That rule is
enforced three ways here: no route defines one, a middleware answers `405` to
every non-`GET`/`HEAD`/`OPTIONS` request, and the connection pool sets
`default_transaction_read_only=on` so Postgres itself would refuse.

**There is no request logging of any kind** — no morgan, no access log, no
`console.log` of a path. The only thing written to stderr is the port at
startup and the message of an unexpected error. Nothing identifies a caller
(hard rule #1). There are no cookies and no sessions; the mod endpoints use a
shared secret header, and that is the entire authentication surface.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | **Required.** Already in the root `.env.example`. |
| `API_PORT` | `3001` | Already in the root `.env.example`. |
| `MOD_API_KEY` | unset | **New — needs adding to the root `.env.example`.** Shared secret for `/mod/*`, sent as `X-Mod-Key`. When unset those endpoints answer `503`; an unauthenticated mod queue is worse than no mod queue. Suggested line: `MOD_API_KEY=change-me-dev-only`. |

Generate a real one with `openssl rand -hex 32`. It is a shared secret between
the operator and the mod tooling, not a per-person credential — there are no
people in this database.

## Endpoints

| Method | Path | Returns |
|---|---|---|
| `GET` | `/healthz` | `{ status, db }`. Pings the database; `503` when it cannot. Used by the compose healthcheck. |
| `GET` | `/feed?board=&cursor=&limit=` | Flicks joined with profiles, newest first, with reply counts and a `nextCursor`. |
| `GET` | `/flick/:id` | One flick, its writer, and the whole comment thread nested. |
| `GET` | `/boards` | Every board with its flick count and latest activity. |
| `GET` | `/writer/:pubkey` | A writer's profile and their flicks, buffed ones excluded. Paginated. |
| `GET` | `/search?q=&limit=` | Full-text search over captions plus a board-tag match. Flicks only for now. |
| `GET` | `/mod/queue?limit=` | Reports with the reported content, its thumbnail, and reporter stats. **Requires `X-Mod-Key`.** |
| `GET` | `/mod/banlist` | Banned pubkeys with their counts. **Requires `X-Mod-Key`.** |

CORS is `*` with no credentials — everything returned here is public content
that anyone could read off the relay anyway.

### Pagination

The feed is keyset paginated on `(created_at, event_id) desc`. A cursor is
base64url of `<created_at>.<event_id>`; pass the `nextCursor` from the previous
response. `nextCursor` is `null` on the last page. `limit` defaults to 24 and
is capped at 50.

Offset pagination would drift as new flicks land at the top, re-showing rows to
anyone scrolling. Keyset pagination cannot.

### Errors

```json
{ "error": { "code": "bad_request", "message": "cursor is not valid" } }
```

Codes: `bad_request` (400), `unauthorized` (401), `not_found` (404),
`read_only` (405), `mod_disabled` (503), `internal` (500).

### Response vocabulary

Responses speak the product's language, not the protocol's: a flick has a
`caption` and a `writer`, and a writer has a `tag` and a **mark** (the 6-char
pubkey fingerprint from `@1nky/protocol`). Tag names are not unique, so the
mark travels with every writer reference — see the copy deck in `CLAUDE.md`.

## Scripts

```sh
pnpm --filter @1nky/api dev        # tsx watch
pnpm --filter @1nky/api build      # tsc -> dist/
pnpm --filter @1nky/api typecheck
pnpm --filter @1nky/api test       # vitest, no database needed
```

## Tests

`pnpm test` boots the real Express app on an ephemeral port against an
in-memory `pg` stub, so middleware order, CORS headers and status codes are
exercised for real. No database is required — CI has none.

The tests that need a real Postgres live in `src/integration.test.ts` and are
skipped unless `PGTEST=1`:

```sh
docker compose -f infra/docker-compose.yml up -d postgres
pnpm --filter @1nky/indexer migrate
PGTEST=1 DATABASE_URL=postgres://oneinky:oneinky@localhost:5432/oneinky \
  pnpm --filter @1nky/api test
```

Those are what prove the SQL is valid; the unit tests only prove it is the SQL
we meant to write.
