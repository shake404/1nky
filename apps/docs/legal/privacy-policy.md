# Privacy policy

::: danger DRAFT — pending counsel review
Working skeleton, written by the builders, not reviewed by counsel, not in force.
Published early so it can be checked and argued with.

**Last updated:** 2026-07-24 · **Status:** draft, not effective
:::

This policy is short. Not because it's been simplified for readability, but because
there is very little to describe. We don't collect personal information, so most of
what a privacy policy normally covers — what we gather, who we sell it to, how long
we keep it, how you request deletion of it — has nothing to attach to.

The engineering claims behind this page are documented with verification steps at
[No logs, by architecture](/privacy/no-logs). If this policy and the code ever
disagree, the code is the fact and the policy is the bug.

## What we do not collect

We do not collect, and have no technical capacity to store:

- **Names, email addresses or phone numbers.** Never requested. There is no field
  for them anywhere in the system.
- **Passwords.** There is no password system.
- **IP addresses.** Request logging is disabled at the web server, and the database
  schema contains no column for an address — not plaintext, not hashed, not
  truncated. This is verifiable with `grep` against the public repository.
- **Login, session or access history.** There are no sessions.
- **Device identifiers, advertising IDs or browser fingerprints.**
- **Location data.** Photo metadata, including GPS coordinates, is destroyed on
  your device before upload. We never receive it.
- **Analytics or behavioral data.** No analytics service, no telemetry, no
  error-reporting service, no third-party scripts, no tracking pixels, no
  advertising anything.
- **Cookies for tracking.** The app sets no tracking cookies.

We have never sold data, do not sell data, and have no business model that would
create a reason to. There is no advertising on 1NKY and no plan for any.

## What does exist

**Your posts.** Everything you post publicly — flicks, comments, threads, profile
tag name — is public content, stored on our relay and served to anyone who visits.
Each post carries the public half of your tag and a signature proving it came from
that tag. That's what makes the platform work; it's public by design and by your
action in posting it.

**The public half of your tag.** A public key. It's a number. It is not linked, on
our side, to a name, an email, a phone number, an address or any other identifier,
because we never had one to link it to. If you link it to yourself by what you post,
that's a choice made in your content, not something our records did.

**A rebuildable index.** A Postgres database holds a denormalized copy of the
public posts, for feeds and search. It contains only what's already public in the
posts themselves, plus derived counts. It can be deleted and rebuilt from the relay
at any time. No addresses, no identifiers.

**Media blobs.** Uploaded images and clips are stored content-addressed — the storage
key is the hash of the bytes, not a filename tied to you. They're re-encoded on
receipt with no metadata carried through, and the original bytes as received are never
persisted.

**Your tag's secret, on your device only.** Held in your browser's local storage on
your device. It is never transmitted to us. We cannot read it, recover it or reset
it.

**Private messages, which we cannot read.** A message is encrypted between the two
devices and reaches us as a sealed envelope signed by a throwaway name and addressed
to the recipient, with the timestamp deliberately smeared by up to two days. We do not
learn the sender, the time or the contents, and messages are not copied into the
searchable index.

**A locked recovery copy — only if you switch it on.** If you opt in to Recovery, we
store an encrypted copy of your blackbook, keyed to your tag's public half. The
passphrase never leaves your device, so we cannot decrypt it, and neither can anyone
who serves us legal process. It is **off by default** and it is the only thing we
store that is linked to a specific tag beyond that tag's public posts.

## Third parties in the path

We'd rather show you the seams than claim there aren't any.

**A static host, for the clearnet app shell.** The HTML, JavaScript and icons that
make up the clearnet app are served as static files by a commercial hosting provider,
which therefore processes requests for those files — including the address they came
from — transiently, under **their** policy, not this one and not our control. What
they serve is identical for every visitor and contains nothing about you. We receive
no visitor addresses from them and enable no analytics with them.

**Hosting and storage providers.** Our server is rented and our media blobs sit on
object storage. Those providers know we are their customer. They have no user data
from us, because we have none to give them.

*There is currently no content-delivery network in front of our origin. When one is
added — the free child-safety scanning tooling we need before a public launch comes
attached to one — this section will say so **before** the change ships, because a
privacy policy that lags the architecture is worse than none.*

*The reason the **onion mirror** exists is that it reaches our box directly over Tor
with none of the above in the path.
[Full explanation.](/privacy/no-logs#what-the-edge-sees)*

**Nobody else.** No analytics vendors, no ad networks, no data brokers, no
third-party fonts or scripts, no embedded social widgets, no customer-support
chat. You can verify this in your browser's network tab in about thirty seconds.

## Your rights

Most data-protection rights are about data we hold that identifies you. We hold
none, so:

- **Access.** Everything associated with your tag is already public and visible to
  you and everyone else. There is no hidden file.
- **Deletion.** You can **buff** any post, and **hang up** your tag, from inside the
  app. It removes the content from the relay and the index. We can't reach copies
  other people already made — no platform can.
- **Correction.** Edit or repost. There's no profile record on our side to correct.
- **Portability.** Your tag and your posts are signed, standard, portable objects.
  Your blackbook is the export.
- **Objection / restriction.** There's no processing to object to beyond hosting
  what you chose to publish. Stop posting and remove your content.

We can't offer identity-verified rights requests, because we cannot verify
identities — that's the same property that protects you. Anything you can do
yourself in the app is the mechanism.

## Children

1NKY is for adults, 18+. We do not knowingly permit use by minors and remove
content involving minors. See the [zero-tolerance CSAM clause](/legal/terms#_3-zero-tolerance-child-sexual-abuse-material).

## Legal process

We will respond to valid legal process, and what compliance can produce is limited
to what exists: public content and public keys. The complete list of what we cannot
produce, and why, is on the
[transparency page](/privacy/transparency#what-we-cannot-produce).

**We cannot produce what we never collected.**

## Changes

This policy lives in a public repository with full commit history. Every version
and every diff is inspectable; material changes will be announced in the app.

## Contact

1NKY is operated by **Bodegga LLC**, a Wyoming limited liability company. Written
notices: Bodegga LLC, 30 N Gould St, Ste R, Sheridan, WY 82801. For security issues
use [responsible disclosure](/security); for anything else, [feedback](/feedback).
