# For the nerds

::: warning This page names names
Everywhere else on this site we describe the system in plain language, because
users shouldn't have to learn a protocol to post a photo. Here we drop that. If
you're auditing the privacy claims, building against us, or just want to know
what's actually running, this is the honest version.

The full design document is in the repository:
[`docs/1nky-research-handoff.md`](https://github.com/bodegga/1nky/blob/main/docs/1nky-research-handoff.md)
(📋 public with launch — the repo is still private, see
[roadmap](/roadmap#not-yet)). It's nine parts and includes the cost model, the phased
build plan and the open risks.
:::

## The one-paragraph version

1NKY uses the **Nostr data model** — signed events, secp256k1/Schnorr, `nostr-tools`
— with a **self-hosted strfry relay as the single source of truth**, a **Postgres
indexer** as a rebuildable read cache, a **read-only Express REST API**, and a
**Blossom-compatible media service** on S3-compatible object storage (a cloud host
Spaces today). The client is a React 18 + Vite PWA that never shows the user any of
those words. We publish to no public relays. The whole thing is also served over a
**v3 Tor hidden service**, from the same origin, with the same build.

::: info Deployment shape, as of this writing
The PWA is static output on Vercel at `1nky.com`; these docs are a second Vercel
project at `docs.1nky.com`. Everything else — strfry, the read API, the media
service, Postgres, the Tor daemon, the nightly backup job — is one Caddy-fronted
Docker Compose stack on a single a cloud host droplet answering as `api.1nky.com`
and as the onion address. **There is no CDN in front of the origin right now.**
:::

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

**Costs stay near zero.** Text on LMDB is negligible, and content-addressed images
with immutable cache headers are the cheapest possible media story. The real bill at
current scale is one small droplet plus one object-storage bucket — **roughly
$12–20/month all in**, with the docs site and the app shell on free static hosting. A
platform that costs nothing to run never needs ads, and a platform that never needs
ads never needs to know who you are.

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
| `0` | NIP-01 | Profile metadata — tag name, city, bio, avatar hash, crews repped, put-on redemption | your tag |
| `20` | NIP-68 picture event | Image posts: URL + SHA-256 in `imeta` tags | **flick** |
| `22` | NIP-71 short-form video | Clips, ≤60s, same `imeta` shape | **flick** (clip) |
| `1` | NIP-01 | Thread OPs on boards; a `happening` date makes it a happening | a thread |
| `1111` | NIP-22 | Comments/replies on flicks and threads, incl. marked mentions | a reply |
| `5` | NIP-09 | Deletion request | **Buff this** |
| `1984` | NIP-56 | Report for moderation | **Flag it** |
| `10000` | NIP-51 | Mute list, applied client-side | **Ignore this writer** |
| `1059` | NIP-59 gift wrap | The only DM kind on the wire | **Word** |
| `30078` | NIP-78 app data | Crew definitions (`d:crew`), board registry, mod bans (`d:ban:<pk>`), put-ons (`d:invite:<id>`), crew-key backups (`d:crewkey:<pk>`) | crews / boards / put-ons |
| `24242` | Blossom BUD-01 | Media upload authorization | (invisible) |

Anything not on that list is rejected by the write policy. Two kinds are rejected
**by number even though we use them**: NIP-59's seal (`13`) and the NIP-17 rumor
(`14`) exist only encrypted inside a gift wrap, so a naked one arriving on a relay
socket is a plaintext DM leak rather than a message, and the policy drops it.

### Mentions, and telling them apart

A NIP-22 comment already carries `p` tags nobody typed — the parent author, the
thread author. So a deliberate `@` mention is marked: `['p', <pk>, '', 'mention']`.
Reply-target `p` tags stay unmarked. That's the whole distinction that lets the
shout-outs inbox exist without treating every reply as a mention. The indexer keeps a
`mentions` table derived from marked tags only (cascading on delete, rebuildable like
every other derived table), and `GET /mentions/:pubkey` reads it.

### Tags that carry weight

- `["t", "sf-bay"]` — city and board routing.
- `["expiration", "<unix>"]` — **NIP-40**. strfry honors it and purges the event.
  This is the entire implementation of ephemeral **beef** threads: 24h / 72h / 7d
  or pinned, selected at post time, enforced by the relay rather than by a cron job
  we could forget to run.
- `["nonce", "<n>", "<target>"]` — **NIP-13** proof-of-work, below.
- `["imeta", ...]` — **NIP-92** media metadata: URL, `x` (SHA-256), dimensions,
  blurhash.
- `["p", "<pk>", "", "mention"]` — a deliberate shout-out, marked to distinguish it
  from the reply-target `p` tags a comment carries automatically.
- Facet tags — a fixed graffiti-type vocabulary (`type…`), a fixed surface
  vocabulary, an optional coarse region, and a one-directional
  `legal-permission` tag. Only the positive legal case exists: a signed,
  permanent "this one was illegal" tag would be a non-repudiable confession sitting in
  the one store this project promises has nothing worth subpoenaing. Absence *is* the
  other case.
- A happening date on a thread, which both files it into `/happenings` and drives an
  expiration a week past the date.

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

| Event | Difficulty in production |
|---|---|
| First-ever event from a pubkey | 18 bits (~1–3s on desktop, longer on old phones) |
| Subsequent posts | 13 bits |
| Reactions | 8 bits |

Tunable live by env var, to be raised if spam appears. The committed target in the
nonce tag prevents lucky-low-work spam from claiming a difficulty it didn't pay
for. The user never learns any of this happened — it's the "spraying…" spinner, and
the word "mining" appears nowhere in the UI.

One production-shaped wrinkle worth writing down, because it bit us: the newcomer
gate is in-process in the relay and resets on restart, so after every deploy a
returning writer's normal-tier post looked like a first-ever event and bounced. The
client now **re-mines once at whatever difficulty the relay names** in its rejection
and resends. Publishing is therefore self-healing across a threshold change, which is
also what makes raising the threshold a config change rather than an outage.

Second layer, third layer: reputation and put-ons, below.

**Reputation.** Pubkey stats in the indexer (age of first event, post count, report
count) feed the write policy, so brand-new pubkeys get tighter limits until they've
been around 48 hours. The same table drives the age dots and standing block in the
UI.

**Put-on trees.** "Getting put on" is an invite as a signed event: a kind-30078 with
`d: invite:<id>`, redeemed by the newcomer's kind-0 carrying an
`invite` tag naming the id and the inviter. A redeemed pubkey skips the newbie
limits, and because redemption records the inviter, the mod side can ban an entire
subtree in one action rather than one pubkey at a time. A put-on is good for one
pubkey; the tree is the anti-spam mechanism *and* the cold-start mechanism.

## Media: Blossom on S3-compatible storage

The media service implements Blossom BUD-01/02: `PUT /upload`, `GET /<sha256>`,
`HEAD /<sha256>`, `DELETE /<sha256>` (owner-signed). Upload auth is a signed
kind-24242 event. Blobs are addressed by SHA-256, which means the same image has
the same address everywhere — mirroring and URL healing come free.

Storage is S3-compatible and therefore swappable; production is currently a
a cloud host Spaces bucket, driven through `@aws-sdk/client-s3` with the endpoint in
config. R2's zero-egress pricing is the reason the design assumed R2 and the reason
moving back to it is a one-variable change if bandwidth ever becomes the bill.

**Client pipeline, before a byte leaves the device:**

1. Draw into a `<canvas>` and re-encode. This destroys **all** metadata — EXIF GPS,
   timestamps, camera serials, embedded original thumbnails — because only pixels
   are copied. The server never possesses the metadata, even transiently.
2. Resize to max edge 2048px; generate a 512px thumbnail locally too.
3. Encode WebP at ~q0.82. Typical flick lands 150–400KB; budget 300KB average.
4. SHA-256 via WebCrypto, sign the kind-24242 auth event, `PUT /upload`.

**Optional face covering, step 0.** `@mediapipe/tasks-vision` face detection, model
and wasm **self-hosted** (a CDN fetch here would be a third-party request, which is a
bug by our own definition). Boxes are painted opaquely onto the canvas *before* the
pipeline above runs, so the covering is in the pixels that get hashed, not a layer.
Off by default; if the detector fails to load, the compose screen refuses to publish
until the writer turns the switch off themselves — failing closed is the only
acceptable direction for this particular feature.

**Server, defense in depth:** `sharp` re-encode (strips anything a hostile client
preserved), reject >5MB, `image/webp|jpeg|png` only, verify the claimed hash
against the body. Storage key is the hash of the **post-re-encode** bytes, which is
what gets returned to the client and referenced in the event's `imeta` tag. The
originally received bytes are never persisted.

**Clips.** Duration is read off a detached `<video>` element on the device and
anything over 60s is refused before an upload starts. Server side, `ffmpeg` lives in
the media image and re-encodes with `-map_metadata -1`, so no container metadata
survives — the same "never persist what arrived" rule as images.

**Serving:** `Cache-Control: public, max-age=31536000, immutable` — legitimate,
because the URL is the hash. With no CDN in front today that immutability mostly buys
browser caching; it's also what makes putting a CDN in front later a pure win with no
invalidation story to design.

## Everything else

**Indexer** — subscribes to the strfry firehose, upserts denormalized feed tables,
Postgres FTS on content and tags, reply counts, report aggregation, crew
membership, pubkey reputation. **The relay is truth; Postgres is cache.** It can be
dropped and rebuilt from the relay at any time, which is also why it's an
uninteresting subpoena target.

**API** — Express 5, **read-only**. Paginated feeds, search (Postgres FTS over
flicks, clips and threads), board lists, happenings, mentions, mod queue. It has no
write path at all, by design, with one deliberate exception noted under escrow below.
NIP-40 expiration is filtered on every public read, so an expired beef is gone from
reads even in the window before the relay's own purge lands. No morgan, no pino-http,
no access logging anywhere in the stack.

**Client** — React 18 + Vite 6 PWA. `nostr-tools` for keys and signing, IndexedDB
for key storage (not localStorage — binary values plus the persistence API),
`navigator.storage.persist()` on every launch, Web Worker for PoW,
`browser-image-compression` for the canvas pipeline. Zero third-party scripts.

The single-slot identity store (`id:'me'`) is deliberately never generalised into a
multi-identity table — an earlier attempt at that broke the app, and the current
"post as crew" feature is instead an **in-memory signer overlay**: crew secrets live
in a separate keyring, the switcher points the signer at one for the session, and the
persisted slot is never written. Reload returns you to your own tag. DMs always sign
with the writer's own key regardless of the overlay, which is a deliberate cut — crew
DMs would otherwise land in a shared inbox.

**Service worker** — `vite-plugin-pwa` with `registerType: 'prompt'`, not
`autoUpdate`. Silent swapping can land mid-upload; prompt mode installs in the
background and surfaces "Fresh coat available — tap to update", plus an hourly and
on-`visibilitychange` `registration.update()` for the tab somebody leaves open for
days. Stale-build-on-phone was the root cause of most "it's broken" reports before
this existed.

**Edge** — none, currently. TLS terminates at our own Caddy for `api.1nky.com`;
`1nky.com` is static output on Vercel. Putting Cloudflare in front is planned, and
the honest reason is less about caching than about the free CSAM Scanning Tool that
comes with a zone — see the [no-logs page](/privacy/no-logs#what-the-edge-sees) for
who sees what in each path, and the [roadmap](/roadmap#not-yet) for status.

**The onion mirror** — a `tor` service in the same compose stack runs a v3 hidden
service pointed at a plain `:8080` Caddy vhost on the internal network, with no host
port published. That vhost mirrors `/relay`, `/api/*` and `/media/*` *and* serves the
PWA's `dist/` from a read-only bind mount — the same build shipped to Vercel, because
`config.ts` detects a `.onion` hostname at runtime and re-points the API, media and
relay bases at `location.origin`. No TLS, deliberately: the address *is* the service's
public key, Tor authenticates and encrypts before the vhost sees a byte, and adding a
CA would insert a trust root into a path that exists to have none. Same rules as every
other vhost: no `log` block, no CORS (upstreams own it), no HSTS, and above all no
redirect to the clearnet host.

**Backups** — nightly `pg_dump` plus a strfry LMDB tarball, pushed to object storage
with a 14-day retention, and a documented restore drill that has actually been run
rather than merely written. Two known weaknesses, both on the roadmap: they land in
the same bucket as media, and the hidden service's `hs_ed25519_secret_key` lives in a
Docker volume that no backup covers — losing it retires the onion address permanently.

**Keys, and the iOS problem.** Blackbook export is NIP-49 (scrypt-hardened,
passphrase-encrypted) as a file plus a QR of the same payload. Second-device
linking is the same payload over QR. The real risk is Safari ITP evicting IndexedDB
after 7 days of no interaction with the site — mitigated by `storage.persist()`,
aggressive PWA install prompting (home-screen web apps are exempt from the 7-day
cap per WebKit's own docs), and relentless backup nagging until a `backedUp` flag is
set. WebAuthn PRF-wrapped keys are the elegant future answer; we're shipping the
boring one first.

**Escrow (optional recovery), the one write endpoint.** Opt-in, off by default. The
client encrypts a NIP-49 blackbook with a passphrase that never leaves the device and
`PUT`s the ciphertext keyed to the writer's own pubkey; `Cache-Control: no-store`,
16KB body cap, never immutable-cached. We hold a blob we cannot decrypt, and it is
[declared on the no-logs page](/privacy/no-logs#subpoena-posture) rather than quietly
omitted, because it's the only user-linked thing we store.

**Crew-key sync.** A crew secret is encrypted *to the holder's own tag* and published
as a kind-30078 under `d: crewkey:<crew pubkey>`. Any device holding that writer's tag
pulls and decrypts it on launch; nothing else can. Crews founded before the feature
get their backup seeded automatically on next launch of the device that holds them.

## What we deliberately did NOT build

The omissions are decisions, not gaps, and each one has a reason.

**Public relay publishing.** Nothing is published to public relays. Kind
20 is the same picture-event kind other clients use, so flicks would leak straight
into their feeds before this community exists — plus we'd inherit public-relay
spam and lose the moderation choke point that makes the whole thing work. Selective
opt-in mirroring stays [parked](/roadmap#parked), not scheduled.

**NIP-29 managed groups.** fiatjaf's own relay29 repo warns it's "probably broken,
don't trust it for anything serious." We use plain kinds plus `t` tags plus our own
relay policy, which does the same job with fewer unknowns. Revisit only if
multi-client interop ever becomes a goal.

**Lightning / zaps.** Payments mean payment rails, payment rails mean KYC-adjacent
metadata, and that is the exact opposite of the product. Also: not needed. Nothing
here costs enough to require monetizing users.

**Unbounded video.** Clips ship — kind 22, hard-capped at 60 seconds with a size
ceiling and an `ffmpeg` re-encode that maps no metadata through. What we didn't build
is video as a first-class format: no long-form, no transcoding ladder, no adaptive
streaming. Video is 30–100× the bytes of images and image economics are the entire
reason this runs for pocket change, so the caps are the feature and they are enforced
on the device *before* an upload starts.

**Accounts, in any form.** No email, no password, no OAuth, no server-side user
record. Not "we don't use it" — the concept doesn't exist in the schema.

**Analytics.** None. Not self-hosted, not "privacy-friendly," not one. Including on
this docs site.

**Push notifications.** No push service, no notification permission prompt, nothing
subscribed on anybody's behalf. Shout-outs are a dot the client computes when you open
it, from a read endpoint, against your own pubkey.

**Multi-identity storage.** Explained above: the persisted identity slot stays
single-valued on purpose, and crew posting is an in-memory overlay instead. The clever
version of this broke the app once already.

## Verify all of it

Claims on this site are meant to be checked, not believed. The
[verification section](/privacy/no-logs#verify-it-yourself) has the greps, the
config files to read, the devtools checks and the `exiftool` walkthrough.

Found a discrepancy between these docs and the code? That's a bug, and depending on
what it is, possibly a security bug: [/security](/security).
