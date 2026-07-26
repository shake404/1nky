# Bugs & feature requests

Pick the right channel and it gets seen faster. Right now **Holler is the one that
actually works** — the code isn't public yet, so neither is the issue tracker.

| You have | Use | Identity needed |
|---|---|---|
| A bug, or a feature idea | [Holler](#holler-in-app-anonymous), in the app | Just your tag |
| A security vulnerability | [Responsible disclosure](/security) | None |
| Anything, once the repo is public | [GitHub Issues](#github-issues) | A GitHub account |

::: danger Don't file security bugs in public
If you've found something that could leak user information, deanonymize a writer,
or compromise tags — do **not** open a public issue and do **not** post it to
Holler. Go to [responsible disclosure](/security) instead. Public disclosure of a
deanonymization vector puts real people at real risk before we can fix it.
:::

## GitHub Issues {#github-issues}

**[github.com/bodegga/1nky](https://github.com/bodegga/1nky)** — 📋 *not public yet;
the link 404s. [Roadmap.](/roadmap#not-yet)* Everything below describes how it'll work
when it lands, and a good bug report looks the same in Holler today.

Best for anything reproducible, anything with a stack trace, and anything you want
to be able to follow along with. Issues are public, searchable, and get linked to
the commits that fix them.

Requires a GitHub account, which means it's not the anonymous channel. If your
GitHub is tied to your name and your report would associate that name with using
1NKY, use Holler instead — that tradeoff is real and we'd rather you pick the safe
option than the convenient one.

**A good bug report has:**

1. What you did, in steps someone else can repeat.
2. What you expected.
3. What actually happened.
4. Browser and OS, and whether you're on the installed app or a normal tab.
5. Whether it happens on clearnet, the onion mirror, or both.
6. Screenshots — [scrubbed of anything identifying](/privacy/opsec), please. Your
   bug report is a post like any other.

**Please don't put in a bug report:** your blackbook, the contents of any backup
file, a passphrase, or a screenshot with any of those visible. There is no support
scenario, ever, where we need your secret. Anyone asking for it is not us.

## Holler — in-app, anonymous {#holler-in-app-anonymous}

**✅ Live. It's in the app: Boards → Holler at us, or `/holler`.**

**Holler** is the feedback board inside the app. Post to it exactly like any other
board: your tag, your words, done. No email, no GitHub, no account, no extra
identity of any kind beyond the tag you already have. You can read what everybody
else has said, too.

It rides the same rails as everything else on 1NKY, which means the same properties
apply:

- Your post is signed by your tag on your device, so we know it's consistently from
  the same writer without knowing who that writer is.
- No IP is recorded when you post it, because none is recorded when you post
  anything. [Same architecture, same verification.](/privacy/no-logs)
- You can post it over the [onion mirror](/privacy/onion) if you don't want anybody
  in the path to see the connection at all.
- You can **buff** your holler later if you change your mind.

**Why bother having a tag on it at all?** So we can reply and you can see the
reply, and so a conversation about a bug can go more than one round. It's a
pseudonym, not an identity — the same pseudonym you already post flicks under, with
nothing extra attached.

**Holler is good for:** "this is broken on my phone," "this word is confusing,"
"the feed does something weird after 30 posts," feature ideas, and telling us the
docs are wrong.

**Holler is bad for:** anything security-sensitive (see the warning above), and
anything you need a guaranteed response to.

## Security vulnerabilities {#security}

Separate process, separate page, private by default:
**[Responsible disclosure →](/security)**

We also publish a machine-readable [`/.well-known/security.txt`](/.well-known/security.txt)
per RFC 9116, so scanners and researchers can find the right contact without
guessing.

**What we care about most:** key custody, the metadata-stripping pipeline, and
anything that deanonymizes a writer. Those are the reports that get dropped on and
fixed first.

## What happens to your report

**Bugs.** Reproduced, triaged, prioritized. Anything in the "leaks user
information" class jumps the queue over everything else, including features. If we
can't reproduce it we'll say so and ask for detail rather than closing it quietly.

**Feature requests.** Triaged onto the **[public roadmap](/roadmap)** — and onto the
copy of it inside the app at `/roadmap`, so you don't have to leave to see where your
idea went. That page is the real backlog, not a marketing artifact: accepted ideas
land in a lane or in the [parking lot](/roadmap#good-ideas-parking-lot). If we say no,
we'll say why on the issue, and "no" usually means "this conflicts with a hard
rule" (adding accounts, adding analytics, adding anything that collects an address)
rather than "we don't like it."

**Doc corrections.** Treated as bugs with the same weight as code bugs. This site's
whole value is that its claims are checkable; a claim that's stale or wrong is a
real defect. If the docs and the code disagree, tell us which one you think is
wrong.

**Response times.** No SLA. This is a small operation with a small number of hands.
Security reports get looked at fastest; everything else gets to when it gets to.
We'd rather promise nothing and answer than promise 24 hours and ghost you.
