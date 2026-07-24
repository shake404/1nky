# `@1nky/indexer`

Subscribes to the strfry firehose, verifies every signature, and upserts the
result into Postgres.

**The relay is the source of truth. This database is a cache.** Anything in it
can be thrown away and replayed — see [Rebuilding](#rebuilding). Design
decisions that follow from that: no derived table is authoritative, migrations
are forward-only, and the recovery plan for a bad migration is a rebuild.

## The cardinal rule

There is no column in this schema that could identify a client. No network
addresses, no user-agent strings, no session table. `src/schema.test.ts` parses
every file in `migrations/` and fails the build if anyone adds one; the
`PGTEST=1` integration test re-checks the same rule against
`information_schema` on a live database.

If that test ever fails, delete the column. Do not relax the pattern.

The process writes **counts and error messages to stderr, and nothing else**.
No event bodies, no pubkeys in log lines, nothing about a connection.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | **Required.** Already in the root `.env.example`. |
| `RELAY_WS_URL` | — | **Required.** Already in the root `.env.example`. |
| `SITE_PUBKEY` | unset | Optional. When set, only this key's kind-30078 event may define boards. Already in the root `.env.example`, but **not currently passed to the `indexer` service in `infra/docker-compose.yml`** — add it there if you use a board registry. |
| `SWEEP_INTERVAL_MS` | `60000` | NIP-40 expiration sweep interval. |
| `RELAY_BACKOFF_INITIAL_MS` | `1000` | First reconnect delay. |
| `RELAY_BACKOFF_MAX_MS` | `30000` | Reconnect delay ceiling. |
| `WATERMARK_OVERLAP_SECONDS` | `300` | How far the watermark rewinds on reconnect. |

Everything except the first two has a working default; none of them are new
secrets.

## Scripts

```sh
pnpm --filter @1nky/indexer dev        # tsx watch
pnpm --filter @1nky/indexer build      # tsc -> dist/
pnpm --filter @1nky/indexer typecheck
pnpm --filter @1nky/indexer test       # vitest, no database needed
pnpm --filter @1nky/indexer migrate    # apply pending migrations and exit
pnpm --filter @1nky/indexer reindex    # throw the cache away and replay
```

> `rebuild` is also a **pnpm built-in command**, so `pnpm --filter @1nky/indexer
> rebuild` silently runs pnpm's native-module rebuild instead of this script and
> exits 0 having done nothing. Use `reindex`, or spell it
> `pnpm --filter @1nky/indexer run rebuild`. Both point at the same script.

## Schema

| Table | Key | What it holds |
|---|---|---|
| `events` | `id` | Every accepted event, verbatim, plus a generated `content_tsv` for search. |
| `flicks` | `event_id` | Kind 20, denormalised for the feed (url, sha256, dims, blurhash, caption, boards). |
| `profiles` | `pubkey` | Kind 0 — tag name, city, avatar hash. |
| `comments` | `event_id` | Kind 1111, with `root_id` / `parent_id`. |
| `reports` | `event_id` | Kind 1984 — reporter, target, reason, note. |
| `deletions` | `event_id` | Kind 5 — the buff request and what it named. |
| `boards` | `slug` | From the signed registry, plus boards discovered in flick `t` tags. |
| `pubkey_stats` | `pubkey` | First event, event count, report count. Maintained by upserts, not triggers, so the logic is unit testable. |
| `banned_pubkeys` | `pubkey` | Operator state. **Not** derived, **not** truncated by a rebuild. |
| `sync_state` | `id` | The firehose watermark. |
| `schema_migrations` | `version` | Created by the runner, not by a migration file. |

Indexes: GIN on `events.content_tsv` and `flicks.boards`, btree on
`(kind, created_at desc)`, and a `(created_at desc, event_id desc)` index on
`flicks` that the feed's keyset pagination reads straight off.

Every derived table references `events(id) on delete cascade`, which is what
makes a buff a single statement.

## How events are handled

| Kind | Routed to |
|---|---|
| 0 | `profiles` + `events` |
| 20 | `flicks` + `events` (+ auto-registers the boards it names) |
| 1111 | `comments` + `events` |
| 1984 | `reports` + `events`, and increments the **reported** writer's `report_count` |
| 5 | `deletions` + `events`, then hard-deletes the named events **that the same pubkey signed** ("buff") |
| 30078 | `boards`, if signed by `SITE_PUBKEY` (or by anyone, when it is unset) |
| everything else | `events` only |

Before any of that: the signature is verified with `verifyEvent` (invalid ones
are dropped and counted), and events whose NIP-40 expiry has already passed are
skipped entirely. A sweep every 60s deletes rows whose expiry has since passed.

## Rebuilding

```sh
pnpm --filter @1nky/indexer reindex
```

1. applies pending migrations
2. `truncate`s every derived table — **not** `banned_pubkeys`
3. re-requests the firehose from `since: 0`
4. indexes everything and exits at end-of-stored-events

Pass `--follow` to keep following the live stream instead of exiting. Stop the
normal indexer container first, or the two will race.

## Tests

`pnpm test` runs against an in-memory `pg` stub and needs no database — CI has
none. The tests that need a real Postgres live in `src/integration.test.ts` and
are skipped unless `PGTEST=1`:

```sh
docker compose -f infra/docker-compose.yml up -d postgres
PGTEST=1 DATABASE_URL=postgres://oneinky:oneinky@localhost:5432/oneinky \
  pnpm --filter @1nky/indexer test
```
