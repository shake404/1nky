# Putting work up

Flicks, clips, and the three ways to find everybody else's.

## Post a flick

**Post** → choose a picture → **Put it up**. That's the whole flow. The
**"spraying…"** wait happens on the way out and takes a second or two.

Before a single byte leaves your device, the picture is redrawn from raw pixels and
re-encoded. That destroys **everything** the camera attached: GPS coordinates, the
capture timestamp, the phone's make, model and serial, and the hidden thumbnail of
the original shot from before you cropped. It isn't cleaned after we receive it —
we never receive it. [Verify that yourself](/privacy/opsec#verify-exif-stripping);
it's a ten-minute check with free tools.

The picture also gets resized and compressed on the way, which is why a 4MB phone
photo leaves as a few hundred kilobytes.

## Clips

Same screen, same button. Pick a video instead of a picture and it goes up as a
clip.

- **60 seconds, hard cap.** The length is read off the file on your device before
  anything uploads, so a long video is refused where you stand rather than after a
  five-minute upload.
- There's a size cap too, and the same metadata strip: our side re-encodes and maps
  no metadata through, so nothing rides along.
- Clips play inline in the wall like flicks do.

## Blur faces

An optional switch on the post screen, **off by default**.

Turn it on and the app finds faces in the picture and covers them — all of it
happening on your device, nothing sent anywhere to be looked at. You can tap
anything it missed to cover that too, and untap a box it got wrong.

Two things worth knowing:

- **The preview is the upload.** You're looking at exactly the pixels that are
  about to go up, not an approximation of them. The covering is destructive; it's
  not a layer somebody can peel off later.
- **If the tool can't come up, posting stays blocked** until you switch the blur
  off yourself. Somebody who asked for faces to be covered should never end up
  posting uncovered faces because a download failed.

Blur is not on for clips.

## Tagging a post

All optional, all there so Explore can find the post later.

| Field | What it does |
|---|---|
| **Where** | A city, and only ever a city. Never a spot, never coordinates. Leave it blank to post to the whole wall. |
| **What** | Fixed list: tag, handstyle, throwie, straight-letter, piece, wildstyle, burner, roller, blockbuster, sticker, freight, streak, production, character. |
| **Surface** | street, freight, passenger, rooftop, tunnel, highway. |
| **Region** | Optional, broader than a city — `bay-area`, that sort of thing. |
| **had permission** | A switch you can turn on when the wall was legal. |
| **Caption** | Optional, up to 500 characters. |
| **Describe it** | Optional, for anyone who can't see the picture. |

::: tip Why there's no "not legal" tag
Only the positive switch exists. A signed, permanent "this one was illegal" tag
would be a confession sitting in the one place this whole project promises has
nothing worth subpoenaing. Saying nothing *is* the other case.
:::

And the obvious one: **city granularity is deliberate.** Don't put the spot in the
caption either.

## The wall

The front door. Everything anybody put up, newest first, scrolling forever. Flicks
and clips together.

## Explore

The wall, filtered. Pick any combination of city, type, surface, region, and "had
permission", and the counts next to each chip tell you what's actually there
before you tap it. Clear a filter or clear the lot.

This is the screen for "show me freights out of the Bay" or "just handstyles."

## Search

Type words. You get three groups back:

- **Walls** — boards matching what you typed.
- **Up** — flicks and clips whose captions or tags match.
- **Talk** — threads and replies.

Search runs over what's up publicly and nothing else. There's no search history,
because there's nowhere to keep one.

**There's no writer-name search**, deliberately-ish: tag names aren't unique, so a
name lookup would mostly be a list of people who might be the person you meant. You
get to a writer by tapping their name on something they put up, and you check the
[mark](/guide/your-tag#your-mark) when you land.

## Your own wall

**Mine** is everything under your tag, plus your bio, your mark, your age, and the
crews you're reppin'. Anybody else's tag gets the same page — tap a writer name
anywhere.

## Buffing

**Buff this** removes your own post. It comes off the wall and out of the index.

It does not come back, and it can't reach anything somebody else already
screenshotted, downloaded or mirrored. If you put up something you shouldn't have,
buff it immediately — speed is the only thing that helps.

You can buff a post you made **as a crew** too, as long as you're still holding
that crew's blackbook.

## Where to go next

- [Boards, beef and happenings](/guide/boards) — talking, not just posting.
- [Crews](/guide/crews) — posting under a shared tag.
- [Opsec for writers](/privacy/opsec) — what's still in the frame after the
  metadata's gone. Read this one.
