# infra/

Everything needed to run 1NKY locally and on a single a cloud host droplet.

```text
infra/
├── docker-compose.yml          postgres · strfry · caddy · api · indexer · media
├── caddy/Caddyfile             no log blocks, header -Server, dev + commented prod vhost
├── strfry/
│   ├── strfry.conf             64KB events, NIP-40 expiry, write-policy hookup
│   ├── write-policy.mjs        stdio plugin: kinds, size, NIP-13 PoW, ban list
│   └── banlist.json            hot-reloaded ban list; WRITTEN BY THE INDEXER (starts empty)
├── docker/
│   ├── strfry.Dockerfile       official strfry image + a node runtime for the plugin
│   ├── api.Dockerfile          Node 22 multi-stage, pnpm workspace
│   ├── indexer.Dockerfile
│   └── media.Dockerfile
├── scripts/
│   ├── package.json            standalone (NOT a pnpm workspace member)
│   ├── pnpm-workspace.yaml     workspace-root marker; stops pnpm walking up
│   └── relay-smoke.mjs         Phase 0 acceptance test
├── deploy/
│   ├── cloud-init.yml          Ubuntu 24.04 bootstrap
│   ├── provision.sh            doctl: droplet + reserved ip
│   ├── deploy.sh               git pull + compose up on the droplet
│   └── dns-runbook.md          the registrar → a cloud host, and the Cloudflare posture
└── README.md
```

`infra/` is **not** a pnpm workspace member — `pnpm-workspace.yaml` globs only
`apps/*` and `packages/*`. `infra/scripts/` has its own `package.json` and is
installed on its own.

---

## Phase 0 acceptance

The handoff's Phase 0 criterion is: *"`docker compose up` → all healthy; `nak`
(or ws script) can publish/query an event against local strfry."* Here is the
whole thing, start to finish.

### 1. Bring up the three core services

```bash
cd infra
cp ../.env.example .env      # optional; every value has a compose default
docker compose up -d postgres strfry caddy
```

`postgres`, `strfry` and `caddy` carry no profile, so they start by name with
no flags. `api`, `indexer` and `media` are in the `full` profile and stay down
— which is what you want, because `apps/*` may not exist yet.

The first run builds the strfry image (official base + a node runtime for the
write-policy plugin). Takes about a minute.

### 2. Confirm health

```bash
docker compose ps
```

All three should read `healthy`. If `strfry` is `unhealthy`, the write policy
is the usual culprit:

```bash
docker compose logs strfry
```

### 3. Run the smoke test

```bash
cd scripts
pnpm install          # standalone install; pulls ws + nostr-tools
node relay-smoke.mjs
```

Expected:

```text
1NKY relay smoke test
  relay      ws://127.0.0.1:7777
  pow        enabled (new=18 post=13)

  throwaway pubkey 3f0a91c2e77b…

  [PASS] websocket connected — ws://127.0.0.1:7777
  [PASS] NIP-11 relay info served — name="1nky" nips=[1,9,11,13,22,40,45,70,77]
      mined kind 0 to 18 bits in 2140ms (271043 hashes)
  [PASS] kind 0 profile accepted
      mined kind 1 to 13 bits in 71ms (8912 hashes)
  [PASS] kind 1 note accepted
  [PASS] REQ by id returns the note — 1 event(s)
  [PASS] REQ by kind + t tag returns the note — 1 event(s)
  [PASS] write policy rejects a note with no proof of work — pow: missing committed difficulty; add a nonce tag targeting 13 bits
  [PASS] write policy rejects a kind outside the allowlist — blocked: kind 9999 is not accepted here

8/8 checks passed — Phase 0 relay acceptance OK
```

The 18-bit mine takes a couple of seconds — that is the point of the gate, and
it is the same work the client will do in a Web Worker behind the
"spraying…" spinner. (Copy deck: the UI never mentions mining.)

### 4. Check it through Caddy too

```bash
curl -s http://localhost/            # -> 1NKY
curl -sI http://localhost/ | grep -i server   # -> no output. header -Server works.

cd infra/scripts
RELAY_WS_URL=ws://127.0.0.1/relay node relay-smoke.mjs
```

All 8 checks pass through Caddy too, NIP-11 included — Caddy forwards the plain
`GET /relay` to strfry, which serves its NIP-11 document at any path.
`/api/*` and `/media/*` return 502 until you bring up the `full` profile; that
is expected, not a misconfiguration.

### Faster iteration

Mining 18 bits on every run gets old. To turn the PoW gate off for local work:

```bash
POW_ENABLED=0 docker compose up -d strfry
POW_ENABLED=0 node scripts/relay-smoke.mjs
```

The script skips the PoW rejection check when `POW_ENABLED=0` and still
verifies publish, query and the kind allowlist. Never do this on the droplet.

### Tear down

```bash
docker compose down          # keeps volumes
docker compose down -v       # wipes the relay DB and Postgres too
```

---

## The full stack

Once `apps/api`, `apps/indexer` and `apps/media` exist:

```bash
cd infra
docker compose --profile full up -d --build
```

Before `pnpm-lock.yaml` is committed, the Dockerfiles' `--frozen-lockfile`
default will fail. Override it:

```bash
PNPM_INSTALL_FLAGS=--no-frozen-lockfile docker compose --profile full up -d --build
```

**One thing this directory cannot fix:** there is no root `.dockerignore`, and
creating one would be a root-file change that `infra/` is not allowed to make.
Without it every app build ships `node_modules/`, `.git/` and `dist/` into the
build context. Recommended contents, for whoever owns the root:

```text
node_modules
**/node_modules
**/dist
**/.turbo
.git
infra/scripts/node_modules
```

---

## Configuration

Compose auto-loads `infra/.env` (the file next to `docker-compose.yml`), and
every variable has a default, so the Phase 0 bring-up works with no `.env` at
all. `cp ../.env.example .env` to override.

These come straight from the root `.env.example`: `DATABASE_URL`,
`RELAY_WS_URL`, `API_PORT`, `MEDIA_PORT`, `R2_*`, `MEDIA_PUBLIC_BASE`,
`SITE_MOD_PUBKEYS`, `SITE_PUBKEY`, `MOD_API_KEY`, `POW_BITS_NEW`,
`POW_BITS_POST`, `POW_BITS_REACTION`, `MAX_UPLOAD_MB`, `NEWBIE_POSTS_PER_DAY`,
`NEWBIE_WINDOW_HOURS`.

`SITE_MOD_PUBKEYS` is read by both `api` and `indexer` — see
[the ban pipeline](#the-ban-pipeline). `MOD_API_KEY` gates `/mod/*` on the api;
unset leaves those endpoints disabled rather than open.

These are **infra-local knobs** — not secrets, not needed by any app, defaulted
in `docker-compose.yml`, and therefore deliberately *not* added to the root
`.env.example` (which `infra/` may not edit). If the orchestrator wants them
documented at the root, these are the ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALLOWED_KINDS` | `0,1,5,20,1111,1984,10000,30078` | Write-policy kind allowlist |
| `MAX_EVENT_BYTES` | `65536` | Write-policy event size cap; mirrors `events.maxEventSize` |
| `POW_ENABLED` | `1` | `0` disables the PoW gate. **Local dev only.** |
| `POW_NEW_KINDS` | `0` | Kinds always charged the `POW_BITS_NEW` tier |
| `POW_REACTION_KINDS` | `1984,10000` | Kinds charged the `POW_BITS_REACTION` tier |
| `BAN_LIST_PATH` | `/app/plugin/banlist.json` | Hot-reloaded ban list, as the **strfry** container reads it (`:ro`) |
| `BAN_LIST_EXPORT_PATH` | `/strfry-plugin/banlist.json` | The same file, as the **indexer** writes it. Not overridable from `.env` — it is the container-side half of a bind mount. Unset disables the export |
| `STRFRY_VERBOSITY` | `WARNING` | strfry log level. **Do not raise to `INFO`** — see below |
| `PNPM_INSTALL_FLAGS` | `--frozen-lockfile` | Build arg for the app Dockerfiles |

Published host ports, all overridable because dev boxes collide:

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_HOST_PORT` | `5432` | Bound to `127.0.0.1` only |
| `RELAY_HOST_PORT` | `7777` | Bound to `127.0.0.1` only |
| `HTTP_PORT` | `80` | Caddy. Leave at `80` in production — ACME needs it |
| `HTTPS_PORT` | `443` | Caddy, TCP + UDP (HTTP/3) |

For example, if you already run a Postgres on 5432:

```bash
POSTGRES_HOST_PORT=5433 docker compose up -d postgres strfry caddy
```

---

## The write policy

`strfry/write-policy.mjs` is **not a compose service**. strfry spawns it as a
stdio child process (`relay.writePolicy.plugin` in `strfry.conf`) and it
inherits the strfry container's environment. `infra/strfry/` is bind-mounted at
`/app/plugin`.

It enforces, in order:

1. **Kind allowlist.** `0` profile · `1` thread OP · `5` delete ("buff this") ·
   `20` flick · `1111` NIP-22 reply · `1984` report ("flag it") · `10000`
   NIP-51 mute · `30078` app-specific (board registry, mod list). Everything
   else is refused at the door.
2. **Ban list**, hot-reloaded from `banlist.json`. Checked before PoW so a
   banned pubkey's mined work is wasted and rejection is instant.
3. **Size cap**, 64KB, matching `events.maxEventSize`.
4. **NIP-13 PoW with the committed-target rule.** A `["nonce", n, target]` tag
   is required; the committed target must meet the demanded difficulty *and*
   the event id must actually meet the committed target. Without the
   commitment an attacker could grind ordinary cheap events and publish
   whichever one got lucky.

Tiers, defaulting to the root `.env.example`:

| Tier | Bits | Applies to |
|---|---|---|
| `POW_BITS_NEW` | 18 | kind 0, and the first event seen from any pubkey |
| `POW_BITS_POST` | 13 | kinds 1, 5, 20, 1111, 30078 |
| `POW_BITS_REACTION` | 8 | kinds 1984, 10000 |

"First event from a pubkey" is tracked in an in-memory set that resets when the
relay restarts — a speed bump, which is the intended Phase 0/1 shape. Phase 2
replaces it with the indexer's pubkey-reputation table (handoff Part 6).

### Banning a pubkey

```bash
# infra/strfry/banlist.json — plain hex, or objects with a `pubkey` field
["3f0a91c2...64 hex chars..."]
```

Save the file. The plugin stats it at most once a second and reloads on change;
no restart, no reconnect. A half-written or invalid file is ignored and retried
rather than treated as "nobody is banned".

Editing the file by hand still works and is the break-glass path, but it is not
the normal one — the indexer owns this file. See below.

### The ban pipeline

A ban is a signed event, not an ssh session. End to end:

```text
  moderator signs kind 30078, d = "ban:<target pubkey>"
      content {"action":"ban","reason":"illegal"}   (or {"action":"unban"})
            │
            ▼  published to strfry like any other event
  indexer firehose  ──▶  @1nky/indexer store.ts
            │            signer must be in SITE_MOD_PUBKEYS, else it is inert
            ▼            app data and nothing is written
  postgres  banned_pubkeys  (pubkey, reason, banned_at, banned_by)
            │
            ▼  banlist-export.ts, on every applied change and at startup
  /strfry-plugin/banlist.json     [{"pubkey":"…","reason":"illegal"}]
            │  (same host dir the relay mounts read-only at /app/plugin)
            ▼  write-policy.mjs stats it ≤1s after the mtime moves
  banned pubkey rejected at the relay door — "blocked: this tag is banned"
```

Notes that matter when you touch any part of it:

* **Authority is `SITE_MOD_PUBKEYS`** (comma-separated hex, root `.env.example`).
  Both the `api` and the `indexer` service get it. From any other signer a
  kind-30078 ban is ordinary app data: it stays in `events` and moves no rows.
* **Two powers, one list.** The same set also lets a moderator's kind-5 take
  down another writer's event. A non-moderator kind-5 stays scoped to the
  signer's own events, which is the "buff this" rule and does not change.
* **`banned_pubkeys` is operator state.** It is deliberately absent from
  `DERIVED_TABLES`, so `pnpm --filter @1nky/indexer rebuild` never unbans
  anyone.
* **Order-independent.** `banned_at` is the event's `created_at`, and both the
  ban upsert and the unban delete carry a SQL guard, so a replayed or
  out-of-order action cannot resurrect a lifted ban or lift a newer one. The
  indexer replays a 300s overlap window on every reconnect, so this is routine,
  not theoretical.
* **Atomic writes.** The exporter writes `banlist.json.tmp` and renames it over
  the target, so the relay never reads a half-written list. This is why the
  indexer bind-mounts the **directory** `./strfry:/strfry-plugin` read-write —
  you cannot rename onto a bind-mounted single file. strfry keeps its own `:ro`
  mount of the same directory at `/app/plugin`.
* **`BAN_LIST_EXPORT_PATH` unset disables the export entirely** (no queries, no
  file). That is the default outside compose, so a dev box without the mount is
  not an error.
* **No pubkeys are logged, ever.** An export failure prints
  `error banlist export failed: <fs error>` and is otherwise swallowed — a full
  disk must not stop the firehose. Applied bans show up only as counts
  (`bans=`/`unbans=`) on the periodic tally.

To confirm it end to end on a running stack:

```bash
docker compose --profile full logs indexer | tail -5   # -> "indexed … bans=1"
cat infra/strfry/banlist.json                          # -> the exported array
```

**Plugin *code* changes need a container restart** (`docker compose restart
strfry`). strfry's mtime-based auto-reload only applies when the plugin command
is a bare script path, and ours is `node /app/plugin/write-policy.mjs`.

### Testing it by hand

The plugin speaks JSON lines on stdin, so you can drive it without the relay:

```bash
echo '{"type":"new","event":{"id":"ff00...","pubkey":"aa..","kind":9999,"tags":[],"content":"","created_at":0}}' \
  | POW_ENABLED=0 BAN_LIST_PATH=infra/strfry/banlist.json node infra/strfry/write-policy.mjs
# -> {"id":"ff00...","action":"reject","msg":"blocked: kind 9999 is not accepted here"}
```

---

## No-logs posture

Hard rule #1 in `CLAUDE.md`, handoff Parts 6 and 8. The pitch to a subpoena is
*"you cannot produce what you never collected"*, and that is only true if it
stays true everywhere.

| Component | How |
| --- | --- |
| Caddy | Zero `log` directives in the Caddyfile. Caddy 2 writes no access log unless one exists, so the absence **is** the configuration. `admin off` also removes `/metrics`. `header -Server`. |
| strfry | `realIpHeader = ""` — it never parses a forwarded client IP, so it has none to hand the plugin. All `relay.logging.*` dumps false, including `invalidEvents`, which upstream defaults to `true`. Plus `--verbosity=WARNING`, which is load-bearing — see below. |
| write policy | Emits exactly `kind=<n> accept` / `kind=<n> reject` on stderr. No pubkeys, no event ids, no content, no `sourceInfo`. |
| api / media | Express 5 with no morgan and no access-log middleware. |
| Postgres | No IP column exists in any table, by schema review. |
| Docker | The default `json-file` driver is kept — **not** `driver: none`. That would also swallow crash traces and startup errors, and we need those to operate the box. The driver only ever receives what the processes above choose to emit, which is not requests. `cloud-init.yml` caps it at 10MB × 3. |
| Host | No remote syslog, no auditd, no log shipper. journald capped at 200MB / 7 days for OS messages. |

Reviewing a change to this directory: if a new service can log a request, it
does not merge. "We can turn it off later" is how this rule dies.

### Why `STRFRY_VERBOSITY=WARNING` is not optional

`relay.logging.*` in `strfry.conf` does **not** cover strfry's own connection
logging. At the default `INFO` verbosity it emits, per websocket:

```text
[1] Connect from 172.19.0.1 compression=Y sliding=Y
[1] Disconnect from 172.19.0.1 (0/-) UP: 1.31K DN: 1.76K Pending: 0b
```

That is an IP address in a log line, which hard rule #1 forbids with no
exceptions clause. Behind Caddy it is only ever the proxy's bridge address, but
anyone who later publishes port 7777 directly would silently start recording
real client IPs. `WARNING` removes those lines along with the per-event
`Inserted event id=…` chatter, and keeps warnings and errors.

It must be spelled `WARNING`. `strfry --help` advertises `WARN`, the parser
rejects it, and a bad value is a fatal startup crash loop rather than a
warning.

**Verified on the running stack.** With the acceptance test driving it, the
strfry container's complete log output is:

```text
kind=0 accept
kind=1 accept
kind=1 reject
kind=9999 reject
```

That is the whole thing. To re-audit after any change:

```bash
docker compose logs --no-log-prefix | grep -nE '([0-9]{1,3}\.){3}[0-9]{1,3}|GET /|X-Forwarded|X-Real-IP'
# any output at all is a bug
```

---

## Deployment

Full detail in `deploy/`. The short version:

> **Executable bits.** These files were authored on Windows, where git's
> `core.fileMode` is `false`, so the `+x` bit is not recorded in the index.
> After the first commit, run this once so `./provision.sh` works on a Linux
> checkout — otherwise it is `permission denied`:
>
> ```bash
> git update-index --chmod=+x infra/deploy/provision.sh infra/deploy/deploy.sh
> ```
>
> Until then, invoke them as `bash infra/deploy/provision.sh`.

```bash
# 1. droplet + reserved ip (idempotent; safe to re-run)
./infra/deploy/provision.sh

# 2. DNS — follow infra/deploy/dns-runbook.md with the reserved ip

# 3. ship it
DROPLET_HOST=<reserved-ip> ./infra/deploy/deploy.sh
```

`provision.sh` creates an `s-1vcpu-2gb` Ubuntu 24.04 droplet in `sfo3` with
`cloud-init.yml` (docker + compose plugin, UFW 22/80/443, fail2ban,
unattended-upgrades, 2GB swap, `/opt/1nky`), then attaches a reserved IP so DNS
is set once and survives rebuilds. It stores no secrets and prints none.

`deploy.sh` does git-pull-on-the-droplet plus `docker compose up -d --build`.
No registry, no CI credentials on the server. Your local `.env` is streamed
over ssh into a 0600 file — never in argv, never in a shell history. Redeploys
and rollbacks do not touch the LMDB or Postgres volumes, so no events are lost.

The handoff (Part 8) specs Hetzner CX32; this targets a cloud host `sfo3` per
the task, on the smaller box strfry's own guide says is sufficient to start.
Watch RAM if you enable `full` — building three Node images on 2GB is why
`cloud-init.yml` adds swap.
