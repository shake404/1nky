# Roadmap

What's built, what's next, and what's still an idea. Statuses are updated as
things land — if this page says something is shipped and it isn't, that's a bug in
the docs and we want the [issue filed](/feedback).

**Status key:** ✅ done · 🔨 in progress · 📋 planned · 💭 idea, not committed

## Where we are today

**Phase 0 is done. Nothing is publicly launched.** The monorepo, the local
infrastructure and the ground rules exist; the app does not yet. Everything from
Phase 1 down is future tense, and this page will not pretend otherwise.

The platform becomes launchable after **Phase 2** — boards, moderation tooling and
the legal pages have to exist before a public link gets shared anywhere, because an
anonymous image platform without moderation tooling is a liability, not a product.

## Phase 0 — Scaffold {#phase-0-scaffold}

**✅ Done**

The boring foundation. Monorepo with workspaces, containerized local stack
(database, relay, web server, service stubs), relay configuration, a stub write
policy, continuous integration running lint/typecheck/test, and the environment
variable contract.

Also settled here: the hard rules everything else is reviewed against — no IP
addresses anywhere, no email/password/OAuth, no request logging, writes are signed
by the client only. Those aren't Phase-N features; they're constraints on every
phase.

## Phase 1 — Tags & flicks {#phase-1-tags-flicks}

**🔨 Next up · the make-or-break phase**

The minimum viable thing: pick a tag, post a flick, see a feed.

| Item | Status |
|---|---|
| Tag generation on-device + persistent local storage | 📋 |
| Onboarding: land → pick a tag → posting, under 60 seconds | 📋 |
| Anti-spam work done invisibly behind the "spraying…" spinner | 📋 |
| On-device photo pipeline: metadata destruction, resize, compress | 📋 |
| Media service: content-addressed upload, server-side re-encode, cheap storage | 📋 |
| Post a flick, global feed, pagination | 📋 |
| Write policy v1: allowed post types, anti-spam threshold, size caps | 📋 |
| Blackbook backup & restore (encrypted file + QR) | 📋 |
| Installable app + backup nagging (the iOS storage-eviction fix) | 📋 |

**Done means:** a fresh incognito browser can go from landing page to a posted
flick in under sixty seconds with zero jargon on screen; an uploaded photo with GPS
metadata provably arrives with none; a backup file restores the same tag in a clean
profile.

## Phase 2 — Boards, beef & moderation {#phase-2-boards-beef-moderation}

**📋 Planned · launchable after this**

| Item | Status |
|---|---|
| City boards | 📋 |
| Threads and replies | 📋 |
| Ephemeral **beef** threads with a lifespan selector (24h / 72h / 7d / pinned) | 📋 |
| **Flag it** reporting flow | 📋 |
| Moderator queue: thumbnail, reporter reputation, one-click takedown + ban | 📋 |
| Ban list enforced at the door, hot-reloaded | 📋 |
| **Ignore this writer** (client-side muting) | 📋 |
| **Buff this** — delete your own posts | 📋 |
| Marks and identicons shown everywhere a tag appears | 📋 |
| Newbie rate limits | 📋 |
| CDN setup including CSAM scanning enabled on the zone | 📋 |
| CSAM reporting + evidence preservation tooling in the mod queue | 📋 |
| Terms, privacy policy and DMCA pages live | 📋 |
| Search across posts and tags | 📋 |

The CSAM tooling in this phase is non-negotiable and gates the public launch. An
anonymous image board **will** be tested, and the response has to be tooling that
already exists on the day it happens.

## Phase 3 — Crews, getting put on & reputation {#phase-3-crews-invites-reputation}

**📋 Planned**

| Item | Status |
|---|---|
| Crews: shared crew identity, crew pages, QR handoff to members | 📋 |
| **Getting put on** — invite codes, invite trees visible to mods | 📋 |
| Subtree bans (ban a spam invite tree in one action) | 📋 |
| Reputation surfaces: tag age, post counts, standing | 📋 |
| Happenings board (event date, auto-expires a week after) | 📋 |
| **Hang it up** — the tag retirement ritual | 📋 |

Invite trees do double duty: they're the anti-spam mechanism that lets trusted
writers skip newbie limits, and they're the cold-start mechanism. Early exclusivity
is a feature, not a bug.

## Phase 4 — Hardening & sovereignty {#phase-4-hardening-sovereignty}

**📋 Planned · onion mirror is launch-blocking**

| Item | Status |
|---|---|
| **.onion mirror** — direct to origin, no CDN in the path | 📋 |
| Client-side face & hand blur, entirely on-device | 📋 |
| Optional encrypted blackbook escrow (we hold ciphertext we can't read) | 📋 |
| Offsite media mirroring for redundancy | 📋 |
| Nightly backups + a rehearsed, documented restore drill | 📋 |
| Load testing under realistic concurrency | 📋 |
| Upload-time CSAM hash scanning, if the application is approved | 📋 |

The onion mirror is the honest answer to the one real wart in the architecture: on
clearnet, a CDN sits in the request path and sees visitor addresses at the edge.
[Full explanation here.](/privacy/no-logs#what-the-edge-sees) We ship it as a
feature, not as a someday.

**Done means:** the site is fully usable in Tor Browser at the onion address, and a
restore-from-escrow round-trips in a clean profile.

## Phase 5 — Maybes {#phase-5-maybes}

**💭 Not committed**

| Item | Status |
|---|---|
| Power-user login with an external signing extension | 💭 |
| Selective mirroring of opted-in public flicks to the wider network | 💭 |
| Short video clips, with hard caps (≤60s, ≤50MB) | 💭 |
| Managed-group protocol support, if cross-app interop ever matters | 💭 |

Video is the one that gets asked for most and is most likely to stay parked. It's
30–100× the bytes of images, and the entire reason this platform can run cheaply
enough to never need ads or accounts is that image economics are trivial. Video
doesn't get in the door until the image economics are proven in production.

## Good ideas parking lot

Things worth building that nobody has committed to a phase. Some are here because
they're genuinely good and unscheduled; some because they're good and hard. A few
name technical machinery — [for the nerds](/for-the-nerds) has the context.

| Idea | What it is | Status |
|---|---|---|
| **Client-side face & hand blur** | On-device detection, destructive blur applied before upload. Nothing sent anywhere for processing. Highest-value item in this table. | 📋 scheduled, Phase 4 |
| **Encrypted blackbook escrow** | You set a passphrase; we store only ciphertext keyed to your public half. We cannot decrypt it. Optional, clearly labeled, purely for recovery. | 📋 scheduled, Phase 4 |
| **Crew threshold keys (FROST)** | Crews currently mean one shared secret, which means one leak burns the crew. Threshold signatures would let *k*-of-*n* members sign as the crew with no single secret to steal. Real cryptography, real complexity. | 💭 idea |
| **Spot map with fuzzy locations** | A map of spots where locations are deliberately coarse — neighborhood-level jitter, never coordinates, privacy-gated and opt-in per post. Genuinely useful, genuinely dangerous if done wrong. Would not ship without a hard privacy review. | 💭 idea, privacy-gated |
| **Sticker & handstyle boards** | Board types tuned for slaps and blackbook pages rather than walls — different aspect ratios, different feed layout. | 💭 idea |
| **Offline-first queue (PWA)** | Compose and queue posts with no signal, flush them when you're back on a network. Obvious fit: the places you take flicks often have no bars, and delayed posting is good opsec anyway. | 💭 idea |
| **Power-user login via signing extension** | Bring your own key manager instead of storing the secret in the browser. Strictly for people who already know what that means; the default path stays jargon-free. | 💭 idea, Phase 5 |
| **Community relay federation** | Let other cities or crews run their own node and federate, so the community survives 1nky.com being gone. The sovereignty story taken to its logical end. Hard problem: federation and moderation pull in opposite directions. | 💭 idea |

Want something on this list, or moved up it? [Ask.](/feedback) Feature requests get
triaged straight onto this page — that's the whole point of keeping it public.
