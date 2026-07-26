# infra

Everything needed to run 1NKY locally and on a single small VPS. Provider-,
region-, and address-specific deployment details are intentionally **not** in
the public repo.

## The no-logs posture (the part worth auditing)

1NKY keeps no record of who connects. That claim is enforced here, in config you
can read:

- **`caddy/Caddyfile`** — contains **zero** `log` directives. Caddy 2 writes no
  access logs unless a `log` block exists, so the absence *is* the configuration.
  No `X-Forwarded-For` / `X-Real-IP` plumbing to any upstream. No admin API.
- **`strfry/`** — the relay runs at `WARNING` verbosity (drops the per-connection
  `Connect from <ip>` INFO lines), `realIpHeader` is `""` so it never parses a
  forwarded client IP, and event/req dumping is off.
- **`strfry/write-policy.mjs`** — the write policy prints exactly
  `kind=<n> <accept|reject>` to stderr: no pubkeys, no event ids, no IPs, ever.
- **`docker-compose.yml`** — the no-logs policy is documented at the top of the
  file, per-service. No service enables request logging; Postgres has no IP
  column by design.

If you find a request log, an IP column, or a client address in any output, that
is a bug — see the [responsible-disclosure policy](https://docs.1nky.com/security).

## Services

| Path | What |
|---|---|
| `docker-compose.yml` | The whole stack; `--profile full` brings up everything |
| `caddy/` | TLS termination + reverse proxy (no logs) + the `.onion` vhost |
| `strfry/` | The relay (source of truth) and its write policy |
| `backup/` | Nightly Postgres + relay-LMDB + onion-key backup to an S3-compatible bucket |
| `tor/` | The hidden-service that serves the full app over Tor |
| `deploy/deploy.sh` | Ships the repo to a host over ssh and rebuilds (host supplied via env) |
| `loadtest/` | k6 scripts |

## Run it locally

```sh
cp ../.env.example .env         # every value has a working default
docker compose up -d postgres strfry caddy      # phase-0 three services
docker compose --profile full up -d --build     # the whole stack
```

Configuration comes from `infra/.env` (gitignored). Nothing secret, and nothing
that identifies a host or provider, lives in this repo.
