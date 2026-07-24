# For the nerds

::: warning This page names names
Everywhere else on this site we describe the system in plain language, because
users shouldn't have to learn a protocol to post a photo. Here we drop that. If
you're auditing the privacy claims, building against us, or just want to know
what's actually running, this is the honest version.

The full design document is in the repository:
[`docs/1nky-research-handoff.md`](https://github.com/bodegga/1nky/blob/main/docs/1nky-research-handoff.md)
(🔨 public with launch). It's nine parts and includes the cost model, the phased
build plan and the open risks.
:::

## The one-paragraph version

1NKY uses the **Nostr data model** — signed events, secp256k1/Schnorr, `nostr-tools`
— with a **self-hosted strfry relay as the single source of truth**, a **Postgres
indexer** as a rebuildable read cache, a **read-only Express REST API**, and a
**Blossom-compatible media service** on Cloudflare R2. The client is a React 18 +
Vite PWA that never shows the user any of those words. We publish to no public
relays.

## Why this architecture

Three options were seriously evaluated: a fully custom stack, a pure Nostr client
on public relays, and the hybrid. The hybrid won on four points.

**Identity is a solved problem.** NIP-01 keypairs and `nostr-tools` mean we write
zero cryptography. The number of ways to get key handling wrong when you roll your
own is not small, and none of them are interesting problems.

**The relay is the community.** This is the relay-as-community pattern. Because
we run the only relay that matters for this app, the strfry **write-policy plugin**
is a single choke point for every inbound event: kind allowlist, proof-of-work
threshold, ban list, size caps, rate limits. On public relays you get none of that
and spam is somebody else's problem, which means it's your problem.

**Portability is free.** Standard signed events mean users own portable identities
and content whether or not we ever turn on interop. If the site dies, the events
are still valid and republishable. That's a real sovereignty property, not a
marketing line — but it costs us nothing at launch.

**Costs stay near zero.** Text on LMDB is negligible. Images on R2 are
$0.015/GB-month with **zero egress at any volume**, behind an immutable CDN cache.
Realistic year-one bill at 1,000 active users is single-digit dollars a month for
media. A platform that costs nothing to run never needs ads, and a platform that
never needs ads never needs to know who you are.

## Data model

Everything is a NIP-01 event:

```json
{ "id": "<sha256 of serialized event>",
  "pubkey": "<32-byte x-only secp256k1 pubkey, hex>",
  "created_at": 1753000000,
  "kind": 20,
  "tags": [["imeta", "url ...", "x <sha256>", "dim 2048x1536"], ["t", "sf-bay"]],
  "content": "",
  "sig": "<schnorr sig over id>" }
```

`id` is the SHA-256 of the canonical serialization; `sig` is a Schnorr signature
over `id`. Authorship is verifiable offline by anyone, forever. That's the whole
trust model — no sessions, no bearer tokens, no server-side authorization state.

### Kinds we use

| Kind | Spec | 1NKY use | User-facing name |
|---|---|---|---|
| `0` | NIP-01 | Profile metadata — tag name, city, avatar hash | your tag |
| `20` | Picture event (Olas-compatible) | Image posts: URL + SHA-256 in `imeta` tags | **flick** |
| `1` | NIP-01 | Thread OPs on boards | a thread |
| `1111` | NIP-22 | Comments/replies on flicks and threads | a reply |
| `5` | NIP-09 | Deletion request | **Buff this** |
| `1984` | NIP-56 | Report for moderation | **Flag it** |
| `10000` | NIP-51 | Mute list, applied client-side | **Ignore this writer** |
| `30078` | NIP-78 app data | Crew definitions, board registry, mod lists | crews / boards |
| `24242` | Blossom BUD-01 | Media upload authorization | (invisible) |

Anything not on that list is rejected by the write policy.

### Tags that carry weight

- `["t", "sf-bay"]` — city and board routing.
- `["expiration", "<unix>"]` — **NIP-40**. strfry honors it and purges the event.
  This is the entire implementation of ephemeral **beef** threads: 24h / 72h / 7d
  or pinned, selected at post time, enforced by the relay rather than by a cron job
  we could forget to run.
- `["nonce", "<n>", "<target>"]` — **NIP-13** proof-of-work, below.
- `["imeta", ...]` — **NIP-92** media metadata: URL, `x` (SHA-256), dimensions,
  blurhash.

## Relay: strfry as source of truth

strfry (C++, LMDB) is the throughput leader and runs comfortably on 1 vCPU / 2GB
per its own deployment guide. It binds to **loopback only**, behind Caddy — from
strfry's perspective every connection in the world comes from `127.0.0.1`, which is
a nice property to have when the goal is not knowing where anyone is.

The **write-policy plugin** is a Node script speaking strfry's stdio protocol. It
sees every inbound event before storage and enforces:

- kind allowlist (the table above, nothing else);
- NIP-13 PoW at or above the current threshold, with a committed target;
- pubkey not on the ban list (Postgres → hot-reloaded JSON);
- event size caps (relay max 64KB);
- per-pubkey rate limits, including tighter newbie limits.

This is the moderation choke point and the anti-spam mechanism in one place, which
is exactly where you want it: at the door, not in the feed.

## Proof-of-work as the CAPTCHA

No accounts means no signup friction for bots either, so NIP-13 does that job. The
event id must have *N* leading zero bits, mined client-side in a Web Worker.

| Event | Starting difficulty |
|---|---|
| First-ever event from a pubkey | 18 bits (~1–3s on desktop, longer on old phones) |
| Subsequent posts | 12–14 bits |
| Reactions | 8 bits |

Tunable live by env var, to be raised if spam appears. The committed target in the
nonce tag prevents lucky-low-work spam from claiming a difficulty it didn't pay
for. The user never learns any of this happened — it's the "spraying…" spinner, and
the word "mining" appears nowhere in the UI.

Second layer: pubkey reputation in the indexer (age of first event, post count,
report count) feeds the write policy, so brand-new pubkeys get tighter limits until
they've been around 48 hours. Third layer, Phase 3: invite trees as signed events —
invited pubkeys skip newbie limits, and mods can ban an entire spam subtree in one
action.

## Media: Blossom on R2

The media service implements Blossom BUD-01/02: `PUT /upload`, `GET /<sha256>`,
`HEAD /<sha256>`, `DELETE /<sha256>` (owner-signed). Upload auth is a signed
kind-24242 event. Blobs are addressed by SHA-256, which means the same image has
the same address everywhere — mirroring and URL healing come free.

**Client pipeline, before a byte leaves the device:**

1. Draw into a `<canvas>` and re-encode. This destroys **all** metadata — EXIF GPS,
   timestamps, camera serials, embedded original thumbnails — because only pixels
   are copied. The server never possesses the metadata, even transiently.
2. Resize to max edge 2048px; generate a 512px thumbnail locally too.
3. Encode WebP at ~q0.82. Typical flick lands 150–400KB; budget 300KB average.
4. SHA-256 via WebCrypto, sign the kind-24242 auth event, `PUT /upload`.

**Server, defense in depth:** `sharp` re-encode (strips anything a hostile client
preserved), reject >5MB, `image/webp|jpeg|png` only, verify the claimed hash
against the body. Storage key is the hash of the **post-re-encode** bytes, which is
what gets returned to the client and referenced in the event's `imeta` tag. The
originally received bytes are never persisted.

**Serving:** `Cache-Control: public, max-age=31536000, immutable` — legitimate,
because the URL is the hash. CDN hit ratio is consequently enormous and R2's
zero-egress pricing does the rest.

## Everything else

**Indexer** — subscribes to the strfry firehose, upserts denormalized feed tables,
Postgres FTS on content and tags, reply counts, report aggregation, crew
membership, pubkey reputation. **The relay is truth; Postgres is cache.** It can be
dropped and rebuilt from the relay at any time, which is also why it's an
uninteresting subpoena target.

**API** — Express 5, **read-only**. Paginated feeds, search, board lists, mod
queue. It has no write path at all, by design. No morgan, no pino-http, no access
logging anywhere in the stack.

**Client** — React 18 + Vite 6 PWA. `nostr-tools` for keys and signing, IndexedDB
for key storage (not localStorage — binary values plus the persistence API),
`navigator.storage.persist()` on every launch, Web Worker for PoW,
`browser-image-compression` for the canvas pipeline. Zero third-party scripts.

**Edge** — Cloudflare free plan: CDN, cache rules on `/media/*`, DDoS, and the free
CSAM Scanning Tool on the zone. Acknowledged tradeoff, discussed at length on the
[no-logs page](/privacy/no-logs#what-the-edge-sees): CF terminates TLS and sees
visitor IPs. The .onion mirror bypasses it entirely and the origin keeps no logs
either way.

**Keys, and the iOS problem.** Blackbook export is NIP-49 (scrypt-hardened,
passphrase-encrypted) as a file plus a QR of the same payload. Second-device
linking is the same payload over QR. The real risk is Safari ITP evicting IndexedDB
after 7 days of no interaction with the site — mitigated by `storage.persist()`,
aggressive PWA install prompting (home-screen web apps are exempt from the 7-day
cap per WebKit's own docs), and relentless backup nagging until a `backedUp` flag is
set. Optional NIP-49-ciphertext escrow is Phase 4. WebAuthn PRF-wrapped keys are the
elegant future answer; we're shipping the boring one first.

## What we deliberately did NOT build

The omissions are decisions, not gaps, and each one has a reason.

**Public relay publishing.** At launch, nothing is published to public relays. Kind
20 is the same picture-event kind Olas uses, so flicks would leak straight into
other clients' feeds before this community exists — plus we'd inherit public-relay
spam and lose the moderation choke point that makes the whole thing work. Selective
opt-in mirroring is a Phase 5 maybe, not a launch feature.

**NIP-29 managed groups.** fiatjaf's own relay29 repo warns it's "probably broken,
don't trust it for anything serious." We use plain kinds plus `t` tags plus our own
relay policy, which does the same job with fewer unknowns. Revisit only if
multi-client interop ever becomes a goal.

**Lightning / zaps.** Payments mean payment rails, payment rails mean KYC-adjacent
metadata, and that is the exact opposite of the product. Also: not needed. Nothing
here costs enough to require monetizing users.

**Video.** 30–100× the bytes of images. The entire reason this can run for pocket
change is image economics. Phase 5 at the earliest, and only with hard caps (≤60s,
≤50MB, server-re-encoded to 720p).

**Accounts, in any form.** No email, no password, no OAuth, no server-side user
record. Not "we don't use it" — the concept doesn't exist in the schema.

**Analytics.** None. Not self-hosted, not "privacy-friendly," not one. Including on
this docs site.

## Verify all of it

Claims on this site are meant to be checked, not believed. The
[verification section](/privacy/no-logs#verify-it-yourself) has the greps, the
config files to read, the devtools checks and the `exiftool` walkthrough.

Found a discrepancy between these docs and the code? That's a bug, and depending on
what it is, possibly a security bug: [/security](/security).
