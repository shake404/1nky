# Roadmap

What's up, what's being worked on, what's queued, and what's parked. The app carries
the same list at **/roadmap** inside it — if this page says something is up and it
isn't, that's a bug in the docs and we want the [issue filed](/feedback).

**Status key:** ✅ up · 🔨 being worked on · 📋 queued · 💭 idea, not committed

## Where we are today

**The app is live at 1nky.com and it is not publicly announced yet.** Everything in
the "Up" section below works right now, on a real box, with real writers able to use
it. What's holding back a public link is on the [not-yet list](#not-yet) — mostly
child-safety scanning at the edge, which is non-negotiable and involves paperwork
rather than code.

## Up already ✅ {#up-already}

### Your tag

| Item | Status |
|---|---|
| Pick a tag and post inside a minute — no email, no phone, no confirmation | ✅ |
| The anti-spam work done invisibly behind the "spraying…" spinner | ✅ |
| Marks and glyphs everywhere a tag appears, plus age dots and standing | ✅ |
| Blackbook: save, lock with a passphrase, restore from file or scanned block | ✅ |
| Link a second device by scanning a block | ✅ |
| Installable app + backup nagging (the iOS storage-eviction fix) | ✅ |
| "Fresh coat available — tap to update" when a new build lands | ✅ |
| Profile pictures, with a drag-and-zoom cropper | ✅ |
| Bios, cities, and the crews you're reppin' | ✅ |
| Optional recovery: we hold a locked copy we cannot open. Off by default | ✅ |
| **Hang it up** — the retirement ritual, with everything taken down | ✅ |

### Putting work up

| Item | Status |
|---|---|
| Flicks, with camera and location details destroyed on your device first | ✅ |
| Short **clips**, hard capped at 60 seconds, same strip | ✅ |
| Optional on-device face blur — nothing sent anywhere to be looked at | ✅ |
| Content-addressed media storage, cheap enough to never need ads | ✅ |
| The wall: everything, newest first, forever | ✅ |
| **Explore**: filter by city, type, surface, region, "had permission" | ✅ |
| **Search** across walls, what went up, and the talking | ✅ |
| **Buff this** — take your own stuff down | ✅ |

### Talking

| Item | Status |
|---|---|
| City boards, started by posting to them | ✅ |
| Threads and nested replies, with reply counts | ✅ |
| **Beef** on a clock — 24h / 3 days / a week / pinned, dropped by the wall itself | ✅ |
| **Happenings** — jams and meets with a date, clearing a week after | ✅ |
| **Shout-outs** — `@` a writer, and an inbox with an unread dot | ✅ |
| **Word** — messages nobody can read but the two of you. Not us either | ✅ |
| **Holler** — the in-app feedback board, on the same anonymous rails | ✅ |
| In-app roadmap, mirroring this page | ✅ |

### Crews

| Item | Status |
|---|---|
| Start a crew, get its blackbook, hand it out | ✅ |
| Crew pages: picture, bio, roster, who's reppin', what they put up | ✅ |
| **Getting put on** the roster — the crew's say, signed by the crew | ✅ |
| Reppin' kept separate from the roster (a claim is not an endorsement) | ✅ |
| Co-management — whoever holds the book runs it, no owner row anywhere | ✅ |
| Bring a crew in from its blackbook on any device | ✅ |
| Crew keys following you across your own devices, automatically | ✅ |
| **Post-as-crew switcher** in the top bar (messages stay on your own tag) | ✅ |

### Moderation & anti-spam

| Item | Status |
|---|---|
| **Flag it** on anything, with a reason | ✅ |
| **Ignore this writer**, carried across your devices | ✅ |
| Mod queue: flagged post, reason, flagger standing, one-tap takedown + ban | ✅ |
| Bans enforced at the door — a banned tag is refused, not hidden | ✅ |
| Tighter limits on brand-new tags | ✅ |
| **Getting put on** the site — one-writer put-ons that skip the newcomer wait | ✅ |
| Whole-tree bans, so a spam family goes in one action | ✅ |
| Terms, privacy policy and DMCA pages live, with a registered DMCA agent | ✅ |

### Sovereignty & keeping the lights on

| Item | Status |
|---|---|
| **The full app over a Tor onion address** — posting, media, everything | ✅ |
| Nightly copies of the database and the wall, with a rehearsed restore | ✅ |
| A beating under load, to find out where the box gives first | ✅ |

## Not yet {#not-yet}

The honest list of what stands between here and a public link, or between here and
sleeping better.

| Item | Status |
|---|---|
| Child-safety scanning at the edge — mandatory before any public link. Needs a content network in front and an application that takes as long as it takes | 🔨 |
| A second home for the nightly copies. Right now they land in the same bucket the pictures do, so one bad day takes both | 🔨 |
| Spare copies of every picture, held somewhere that is not us | 📋 |
| The code going public, so every claim on this site can be checked by anybody | 📋 |
| A signed warrant canary — right now the canary is unsigned and [says so](/privacy/transparency) | 📋 |
| Counsel review of the terms and privacy policy, both of which are labelled drafts | 📋 |
| Covering hands and other tells automatically, not just faces | 📋 |
| The onion address advertised to your browser automatically instead of by hand | 📋 |

## Parked 💭 {#parked}

Good ideas nobody has promised. Some are here because they're unscheduled, some
because they're hard.

| Idea | What it is | Status |
|---|---|---|
| **Crew keys that take several members** | A crew currently means one shared book, so one leak burns everybody. Splitting it so *k* of *n* members are needed to speak for the crew is real cryptography and real complexity. | 💭 |
| **Spot map with fuzzy locations** | A map where the locations are deliberately coarse — neighbourhood, never coordinates, opt-in per post. Genuinely useful, genuinely dangerous done wrong. Wouldn't ship without a hard privacy review. | 💭 |
| **Sticker & handstyle boards** | Board types tuned for slaps and blackbook pages rather than walls — different shapes, different layout. | 💭 |
| **Write it with no bars** | Compose and queue with no signal, let it go up when you have some. The places you take flicks often have no signal, and posting late is better practice anyway. | 💭 |
| **Hold your tag in your own app** | Bring your own key manager instead of storing it in this one. Strictly for people who already know what that means; the default path stays plain. | 💭 |
| **Other cities running their own box** | Let a city or a crew run its own node and join up, so this place surviving stops depending on us. Hard problem — joining up and moderating pull in opposite directions. | 💭 |
| **Sharing flicks out to the wider network** | Opt-in mirroring of public flicks beyond 1NKY. Off, and off by default forever; the moderation choke point is the thing that makes this place work. | 💭 |

## Good ideas parking lot {#good-ideas-parking-lot}

That's the table above — it kept its old link so nothing that pointed at it breaks.

Want something on it, or moved up it? [Ask.](/feedback) Feature requests get triaged
straight onto this page and the one inside the app. That's the whole point of keeping
it public.
