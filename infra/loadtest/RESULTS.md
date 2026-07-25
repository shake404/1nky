# Load test — 2026-07-25 (HANDOFF item P)

Run against production (`wss://api.1nky.com/relay`, `https://api.1nky.com/api`)
from a single k6 container. Script: `relay-load.js`. Raw: `results/summary.json`,
`results/run.log`.

## Shape

- **500 concurrent WebSocket subscriptions**, ramped 0→500 over 1m, held 3m,
  each: REQ a small filter, wait for EOSE, hold the socket 20–40s, CLOSE.
- **API reads** at 5 rps across `/feed`, `/boards`, `/explore/facets`.
- Uploads scenario left off this run (read/subscribe is the launch-day shape;
  the writer path is PoW-gated and covered by the live E2E probes instead).

## Result — every threshold green, wide margin

| Metric | Threshold | Observed |
|---|---|---|
| relay EOSE p95 | < 2000 ms | **81 ms** (avg 55, max 1.07s) |
| relay WS failures | < 25 | **0** / 3896 sessions |
| API read p95 | < 1500 ms | **29.5 ms** (avg 18) |
| API failure rate | < 2% | **0.00%** / 1351 reqs |
| checks | — | **5207 / 5207** (100%) |

vus_max 510, ws_connecting p95 65ms. 23 MB received / 7.8 MB sent over 5 min.

## Read

The 2-vCPU / 2 GB droplet holds 500 concurrent readers with two orders of
magnitude of latency headroom — EOSE at 81ms p95 against a 2s budget. No bump
needed for a launch at this scale. Where it would first bend is **write**
throughput (PoW verification + Postgres indexing under a burst of uploads),
not read fan-out; re-run with `UPLOADS_FILE` set (see `gen-uploads.mjs`, to be
added when a write soak is wanted) before any campaign that expects a posting
spike. strfry's per-connection memory is the ceiling to watch past ~a few
thousand simultaneous sockets.
