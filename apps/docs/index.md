---
layout: home
title: What 1NKY is
hero:
  name: 1NKY
  text: No accounts. No emails. No logs.
  tagline: An anonymous platform for writers. Your tag lives in your pocket, not on our servers.
  actions:
    - theme: brand
      text: How it works
      link: /how-it-works
    - theme: alt
      text: Using it
      link: /guide/your-tag
    - theme: alt
      text: Check our claims
      link: /privacy/no-logs
features:
  - title: There is no signup
    details: No email. No phone. No password. No "continue with Google." You pick a tag and you're in — usually under a minute.
  - title: Your tag is yours
    details: It's made on your device and stored on your device. We never hold it, can't reset it, and can't hand it to anyone.
  - title: Nothing to hand over
    details: The web server writes no request logs and the database has no field for an IP address. We cannot produce what we never collected.
  - title: The whole thing runs over Tor
    details: An onion address serves the full app — posting, pictures, messages, all of it — straight to our box with nothing in between.
---

## The short version

1NKY is a place to post flicks, run boards and talk shit without leaving a paper
trail that ends with a detective at your door.

Every other platform that writers use was built around a profile: an email, a phone
number, a follower graph, a login history, an ad ID. That profile is the product,
and it is subpoenable. Writers get identified off their own Instagram accounts
routinely — the follower graph, the caption, the face in the background of a flick.
That's not paranoia, that's case law and press releases.

So 1NKY doesn't have profiles in that sense. It has **tags**, and a tag is not an
account on our system. It's a secret that gets made on your phone or laptop, stays
there, and is used to put your name on your posts in a way that anyone can verify
and nobody can forge.

## What's actually in it

All of this is live right now, not planned:

- **Flicks and clips** — photos and 60-second videos, with the camera's location
  and identifying details destroyed on your device before upload, plus an optional
  on-device face blur. [How posting works.](/guide/posting)
- **The wall, Explore and Search** — everything newest-first, filtered by city,
  type and surface, or searched across walls, posts and threads.
- **Boards, beef and happenings** — city boards, threads, arguments on a clock that
  the wall throws away itself, and jams with a date on them.
  [Boards.](/guide/boards)
- **Crews** — a shared tag, a crew page, a roster, and a switcher in the top bar for
  posting as one. [Crews.](/guide/crews)
- **Shout-outs and word** — `@` a writer publicly, or send a message nobody but the
  two of you can read. [Talking.](/guide/talking)
- **Moderation that works without identity** — flag it, ignore a writer, buff your
  own stuff, and put a writer on. [Moderation.](/guide/moderation)
- **A Tor onion mirror of the whole app.** [The onion mirror.](/privacy/onion)

## What that buys you

**Nothing to log in to.** There is no password to phish, no email to link back to
you, no "forgot password" flow that leaks your identity to a mail provider.

**Nothing to leak.** We don't run request logs, and the database schema has no
column for an IP address — not a nulled-out one, not a hashed one, none. See
[No logs, by architecture](/privacy/no-logs), which tells you exactly where to look
in the code to confirm it.

**Nothing in your photos.** Camera metadata — GPS coordinates, timestamps, the
serial number of your phone — is destroyed **on your device** before a single byte
is uploaded. We never receive it, so we can never lose it.
See [Opsec for writers](/privacy/opsec) for how to verify that with `exiftool`.

**Nothing that dies with us.** Your tag and your posts are cryptographically yours.
If 1NKY gets raided, sued, or hit by a bus, the identity in your pocket still works.

## What it doesn't buy you

We're not going to sell you magic. Read this part twice.

- **1NKY is not anonymity software.** It's a website with a serious privacy
  posture. If your threat model is a nation-state, use Tor and don't take our word
  for anything.
- **The ordinary site has other people's computers in the path.** `1nky.com` is
  served as a static app shell from a commercial host, which sees a request coming
  from somewhere. Our own box keeps nothing either way, and the
  [onion mirror](/privacy/onion) removes those hops entirely — that's what it's for.
- **You can still dox yourself.** A landmark, a hand, a distinctive jacket, a tag
  name you already use on a platform tied to your legal name — the architecture
  can't save you from any of that. [Read the opsec page.](/privacy/opsec)
- **Lose your tag, lose your name.** Nobody can recover it. Not even us.
  Especially not us. Save your blackbook.

## Why the docs are public

Every privacy pitch on the internet is a paragraph of adjectives. This site is
built to be checked, not believed. Where we make a claim, we try to point at the
file, the command, or the browser tool that proves it — and where we can't prove
something yet, we mark it as a promise instead of dressing it up as a fact.

The code itself is not public yet. That's on the [roadmap](/roadmap#not-yet) and
it's the biggest thing still owed to anybody reading these pages sceptically: until
it lands, the checks you can run on your own device (devtools, `exiftool`) are the
ones that don't require trusting us.

If you find a place where the docs and the app disagree, that's a bug and we want
to hear about it: [report it here](/security).
