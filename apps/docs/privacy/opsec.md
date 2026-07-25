# Opsec for writers

The architecture protects you from us. It cannot protect you from you.

Everything on this page is about the second part: the ways people actually get
identified from their own posts. Read it before you post your first flick, not
after.

## How writers actually get caught

Not by exotic surveillance. By their own social media.

This is documented, not hypothetical. Detectives don't crack cryptography; they
scroll. In San Francisco in 2024, a round of graffiti arrests included a writer
identified alongside his 10,000-follower Instagram account. In Greensboro in 2026,
police built a case starting from a social-media tip and profile photos.
Prosecutors regularly describe scouring social accounts as ordinary investigative
work, and platform data — the account, the login IPs, the DMs, the follower
graph — is subpoenable in a way that requires nothing more than a form.

The pattern repeats in almost every case:

1. A flick gets posted publicly, often within hours of the piece going up.
2. The account posting it has a follower graph full of people the writer knows in
   real life.
3. Something in a photo — a face, a hand, a car, a storefront across the street,
   the reflection in a window — narrows the geography or the person.
4. Metadata in the file, or an account tied to an email or phone, closes it.
5. A subpoena to the platform fills in the rest.

1NKY removes steps 4 and 5 by design: there's no account tied to an email, no login
history, no IP records, and photo metadata is destroyed before upload. Steps 1
through 3 are still entirely on you.

## Metadata: handled, but verify it

Every photo your phone takes carries a payload you didn't ask for: GPS coordinates
accurate to a few meters, a capture timestamp to the second, the camera's make,
model and sometimes serial number, and often an embedded thumbnail of the
*original* image from before you cropped it.

**On 1NKY, that payload is destroyed on your device.** When you pick a photo, the
app draws it into a canvas and re-encodes it from raw pixels. Re-encoding doesn't
"clean" the metadata — the metadata simply has no way to survive the operation,
because only pixels get copied. The image is resized (max edge 2048px), encoded to
WebP, and only then does anything leave your machine.

The key property: **we never receive your metadata, even for a moment.** It's not
stripped server-side after upload, where a crash, a cache or a backup could
preserve it. It's gone before the network is involved. The server then re-encodes
again with `sharp` as defense in depth, and never stores the bytes it received.

### Verify EXIF stripping {#verify-exif-stripping}

Don't take that on faith. It's a ten-minute check with free tools.

**Step 1 — confirm your source file is dirty.** Pick a photo you took outdoors with
location services on:

```bash
exiftool -G -a -s dirty-photo.jpg
```

You want to see `GPSLatitude`, `GPSLongitude`, `DateTimeOriginal`, `Make`, `Model`.
If your source has no GPS in it, the test proves nothing — find one that does.

**Step 2 — watch what leaves your machine.** Open devtools → Network before you
upload. Post the flick. Find the upload request, and check the size of the request
body. A 4MB phone photo should be leaving as a few hundred kilobytes — that size
collapse is the re-encode happening locally. You can also right-click the request
and save the payload.

**Step 3 — check what came back.** Download the image the site serves, straight
from the media URL:

```bash
curl -sO https://1nky.com/media/<sha256>
exiftool -G -a -s <sha256>
```

Expected output: image dimensions, color profile, and nothing else. No GPS block.
No timestamps. No camera identity. If you see anything from step 1 survive to step
3, stop posting and [report it as a security issue](/security) — that's exactly the
class of bug we care most about.

**Bonus check.** Compare the SHA-256 of what you uploaded against the hash in the
served URL. Content addressing means the URL *is* the hash of the bytes; if they
match, you're looking at exactly the file that was stored, not a re-processed
lookalike.

## What's still in the frame

Metadata is the easy problem. Pixels are the hard one, and no amount of
cryptography helps here.

**Faces.** Yours, your friends', a bystander's. A face in the background of a flick
has ended cases. Crop, don't post, or wait for the blur tool.

**Hands and arms.** Underrated. Tattoos, rings, watches, scars and even knuckle
shape have been used for identification. A gloved hand holding a can is fine; a
bare forearm with a distinctive piece is a signature.

**Landmarks and geography.** The obvious ones you'll catch — a street sign, a
storefront, a stadium. The ones that get people: a specific train car number, the
skyline visible between two buildings, a distinctive utility pole, the pattern of a
fence, a rare curb design, the reflection in a window or a car door.

**Your own gear.** Cap colors and can brands are fingerprints across a body of
work. So is your handstyle, which you can't hide and shouldn't try to — but be
aware that a distinctive handstyle plus one geographic slip links every other post
you've made.

**Timing.** Posting a flick of a fresh piece within an hour of doing it puts you
somewhere at a time. Sit on flicks. There's no engagement algorithm here rewarding
you for being first.

**Weather and light.** Shadows give time of day. Wet pavement gives a date. It's
tedious to exploit, but it has been done.

::: tip Coming in Phase 4
Client-side face and hand blur — detection and blurring done entirely on your
device, nothing sent anywhere for processing, applied before the re-encode.
[Track it on the roadmap.](/roadmap#phase-4-hardening-sovereignty)
Until it ships, blur it yourself before you upload, and check your blur is
destructive (a black box drawn over pixels), not an overlay in some editor's
project file.
:::

## Your tag name is a link

The single most common self-dox on an anonymous platform is name reuse.

**Never reuse a tag name from any platform tied to your identity.** If the name is
on an Instagram that's linked to your phone number, on a Discord that's linked to
your email, on a Reddit account that once mentioned your city, or on anything with
a payment method attached — pick a different one here. Correlating names across
platforms is the cheapest investigative technique that exists and it's fully
automated.

Same for:

- **Writing style and inside jokes** that appear on both accounts.
- **Posting the same flicks** you posted elsewhere. Image hashes are trivially
  comparable, and reverse image search is free.
- **Crew names and affiliations** that already appear next to your identified
  accounts.
- **Timezone tells.** If you only ever post between 11pm and 2am Pacific, that's a
  data point in any correlation.

Treat the tag as a clean identity from day one. You can't retroactively unlink it.

## Use the onion mirror if you're serious

Clearnet 1NKY passes through Cloudflare, which sees your IP transiently at the
edge — we explain that honestly on the [no-logs page](/privacy/no-logs#what-the-edge-sees).
Our origin keeps no logs, but the edge is a third party in the request path.

The **.onion mirror** removes that entirely: Tor Browser → hidden service → our
origin. No CDN, no third-party TLS termination, no IP visible at any hop, no ISP
record that you visited a graffiti site.

```text
http://jd3i7s473cmwlxvfqynshzodo5rwtfrpkjtu5lhpbfguqd3u4uzqzfyd.onion
```

One honest caveat while we finish the wiring: the site and its data ride the
hidden service end to end, but flick images themselves currently still load
from the clearnet media host. Inside Tor Browser that fetch still goes through
Tor — your IP stays out of it — it just crosses the regular edge instead of the
hidden service. We're closing that gap; until then this note stays here.

If you post flicks of your own work, this should be your default path, not your
paranoid path. Combine it with:

- **Tor Browser at default security settings** — don't customize it, that makes you
  more identifiable, not less.
- **A device that isn't your daily driver**, if you can manage it.
- **Not logging into anything identifiable** in the same browser session. Ever.

Onion mirror status: Phase 4, launch-blocking.
[See the roadmap.](/roadmap#phase-4-hardening-sovereignty)

## Your blackbook is also an opsec object

The file that backs up your tag is the one thing that can prove you are you.
Which means it's also the one thing that can prove you are you.

- **Encrypt it with a real passphrase.** The app offers this; take it. An
  unencrypted backup file sitting in your Downloads folder is a confession waiting
  for a device search.
- **Don't put it in a cloud drive tied to your name.** That's a subpoenable copy of
  your identity sitting in someone else's datacenter under your legal name.
- **A printed QR in a physical place** is a legitimately good backup, and it's not
  searchable remotely.
- **Don't screenshot it to a phone that auto-syncs photos.** Same problem as the
  cloud drive, with an extra step of it also being in a machine-learning pipeline.

## The one-minute checklist

Before every post:

- [ ] Photo re-shot or cropped so no faces are in frame
- [ ] No bare hands, tattoos, or distinctive jewelry visible
- [ ] No street signs, storefronts, car plates, or train numbers
- [ ] Nothing readable in reflections (windows, car doors, puddles)
- [ ] Not posted within hours of the piece going up
- [ ] Tag name shares nothing with any account tied to your name
- [ ] Using the onion mirror if this is your own work
- [ ] Blackbook backed up, encrypted, not in a named cloud account

## When something goes wrong

If you've posted something you shouldn't have, **buff it immediately** — the app
removes it from the relay and the index. Understand the limit: anything already
downloaded, screenshotted or cached by someone else is beyond anyone's reach,
including ours. Speed matters.

If you think there's a flaw in the platform that leaks user information — the EXIF
pipeline, key handling, a deanonymization vector — that's the highest-priority class
of bug we accept. [Responsible disclosure here.](/security)
