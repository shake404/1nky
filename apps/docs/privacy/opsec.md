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

**Clips give away more than flicks.** A 60-second video is sixty seconds of
background: voices, a train announcement, a passing plate, the way you walk, the
route you took out. The metadata is stripped the same way and the face blur does not
run on video. If you post clips, watch them back with the sound on before they go up.

::: tip Face blur is live — use it
There's a **blur faces** switch on the post screen. Detection and blurring happen
entirely on your device; nothing is sent anywhere to be looked at. What you see in
the preview is exactly the pixels that upload, the covering is destructive, and you
can tap anything the detector missed.

It's **off by default** — a tool that quietly alters somebody's picture is worse than
no tool — so you have to turn it on. If it can't start, posting stays blocked until
you switch it off yourself, so a failed download can never turn into uncovered faces.

Two gaps to know about: it doesn't cover **hands** (that's still on you, and see
below), and it doesn't run on clips. For anything it can't handle, blur it yourself
before you upload and check your blur is destructive — a box drawn over pixels, not
an overlay in some editor's project file. [Roadmap.](/roadmap#not-yet)
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

Clearnet 1NKY is an app shell served by a commercial static host talking to our own
box — [who's actually in that path](/privacy/no-logs#what-the-edge-sees) is spelled
out honestly on the no-logs page. Our box keeps nothing, but other people's computers
are in the request path, and your ISP can see you looked us up.

The **onion mirror** removes all of that: Tor Browser → hidden service → our box. No
static host, no content network, no third-party TLS termination, no DNS lookup, no
address visible at any hop.

```text
http://jd3i7s473cmwlxvfqynshzodo5rwtfrpkjtu5lhpbfguqd3u4uzqzfyd.onion
```

**The whole app is on it now** — posting, flicks, clips, media, messages, crews, all
of it on that one address. The old half-mirror caveat (pictures loading from the
clearnet host) is fixed; if you find anything at all still loading from `1nky.com`
while you're on the onion, that's a bug and a
[disclosable one](/security).

Check the address character by character. There's no registrar to stop somebody
publishing a lookalike, and the authoritative copy lives here and on
[the onion page](/privacy/onion) — not in a forum post or a DM.

If you post flicks of your own work, this should be your default path, not your
paranoid path. Combine it with:

- **Tor Browser at default security settings** — don't customize it, that makes you
  more identifiable, not less.
- **A device that isn't your daily driver**, if you can manage it.
- **Not logging into anything identifiable** in the same browser session. Ever.

[Full detail on the onion mirror.](/privacy/onion)

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
- **A crew blackbook is everybody's blackbook.** Whoever holds it *is* the crew. A
  crew is exactly as careful as its least careful member, and there's no way to take
  the file back once you've handed it over — only to buff someone off the roster.
  [How crews work.](/guide/crews)
- **If you switch on Recovery**, we hold a locked copy of your blackbook. We can't
  open it and neither can anyone who serves us paper, but it exists, and a passphrase
  you'd use elsewhere is the weak link in that. Use one you don't use anywhere else.

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
