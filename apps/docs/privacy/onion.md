# The onion mirror

The whole app, over Tor, straight to our box. Same screens, same tag, same
everything — different address bar.

```text
http://jd3i7s473cmwlxvfqynshzodo5rwtfrpkjtu5lhpbfguqd3u4uzqzfyd.onion
```

Open that in **Tor Browser**. That's the entire setup.

## What "the whole app" means

This used to be a half-mirror — you could read over Tor but the pictures still came
from the ordinary site. That's finished. Everything now rides the one address:

| | Over the onion |
|---|---|
| Browsing the wall, boards, threads | ✅ |
| Picking a tag, restoring one | ✅ |
| Posting flicks, clips, threads, replies | ✅ |
| Loading flicks and clips | ✅ |
| Messages | ✅ |
| Crews, shout-outs, search, happenings | ✅ |

It is the same app, byte for byte — it notices it's being served from an onion
address and points everything it needs back at that same address instead of the
ordinary one.

## Why you'd use it

Plainly: **so that nothing between you and us ever sees where you are.**

Over Tor there is no content network in front of us, no certificate authority, no
DNS lookup that says you were interested in a graffiti site, and no address arriving
at our door for anyone to write down. Our side keeps no visit records either way —
[that part is architecture, and you can check it](/privacy/no-logs) — but the onion
path removes the question rather than answering it.

Your internet provider sees you using Tor. It does not see that you used 1NKY. That
is the trade, and for a lot of people it's the right one.

**If you post flicks of your own work, this should be your normal path, not your
paranoid one.**

## Why there's no padlock

The address itself is the site's identity — that string of letters *is* how Tor knows
it reached us and nobody else. Tor encrypts and authenticates the whole way before
our side sees a single byte, so a certificate would only add a company to a trust
chain that deliberately doesn't have one. Browsers treat `.onion` addresses as secure
for exactly this reason.

An `http://` onion is not a downgrade from an `https://` clearnet site. It's a
different, shorter trust path.

## Honest caveats

**Check the address, character by character.** Onion addresses are 56 random-looking
characters and there is no registrar to stop somebody publishing a lookalike with a
phishing page behind it. The authoritative copy of ours is on this page, on
[the opsec page](/privacy/opsec), and nowhere else. If you got it from a forum post
or a DM, come here and compare it.

**We don't redirect you to it.** The ordinary site does not advertise the onion
address to your browser automatically, so you have to come here and take it. That's
one fewer moving part between the two paths.

**It's slower.** Tor is slower, and uploading a clip over it is genuinely slow. The
app is compressed harder on this path to help.

**Tor Browser at default settings.** Don't customise it, don't add extensions, don't
resize the window into a distinctive shape. Customisation makes you more
identifiable, not less. And don't log into anything tied to your name in the same
browser session — ever.

**It doesn't fix what's in the photo.** A landmark, a face, a distinctive forearm:
Tor has nothing to say about any of that. [Read the opsec page.](/privacy/opsec)

## What the clearnet path looks like by comparison

The ordinary `1nky.com` is a static app shell served from a commercial static host,
talking to our own box for everything real — the wall, media, posting. Our box keeps
no visit records, and the app shell is the same files for everybody with nothing in
it about you. But the hosts in that path are third parties, and third parties get to
have their own policies and their own legal process.

Positioned plainly: **clearnet is the convenient path, onion is the sovereign path.**
Pick according to your threat model, and there's no penalty for switching between
them — it's the same tag and the same wall either way.

## Where to go next

- [Opsec for writers](/privacy/opsec) — the part Tor can't help with.
- [No logs, by architecture](/privacy/no-logs) — the claims and how to check them.
- [For the nerds](/for-the-nerds) — how the mirror is actually wired.
