# Responsible disclosure

::: warning For the nerds
This page is written for security researchers and names specific technical
machinery. If you just want to report a normal bug, use [feedback](/feedback).
:::

If you've found a way to break 1NKY, we want to hear it from you before we hear it
from a court filing. This page is the whole policy: what's in scope, what we care
about most, what we'll do, and what you get.

## Contact

**Machine-readable:** [`/.well-known/security.txt`](/.well-known/security.txt)
(RFC 9116).

Pick whichever channel fits how sensitive the finding is. In rough order of how
much we'd prefer it for a real vulnerability:

- **Email, encrypted:** **security@bodegga.net**, encrypted to our PGP key (below).
  This is the right channel for anything in the high-severity classes.
- **Email, plain:** the same address without encryption, if the finding isn't
  sensitive in transit. Say "encrypted reply please" and we'll take it back to PGP.
- **GitHub private vulnerability reporting:** once the repository is public, use
  GitHub's "Report a vulnerability" (Security Advisories) — a private thread with
  us, no public trace until we publish together.
- **Through 1NKY itself:** send an encrypted message to the site's tag,
  `npub1sgcjdqktpxfqnzr7zfz2d7ngn6dl8cf934eukk2fpz3hu0wdq8xqfsgsgq` — end-to-end
  encrypted the same way every message here is, no email required.
- **In-app [Holler](/feedback):** for a first contentless ping if you have no other
  way to reach us — say *that* you found something and how to reach you securely,
  never *what*.

If a finding is in the highest-severity classes below and you judge that even
saying "I found something" is too much, the entity's postal address is on the
[transparency page](/privacy/transparency#contact).

**PGP key:** [`security-at-bodegga.asc`](/security-at-bodegga.asc), also linked from
`security.txt`.

```text
Fingerprint: 7D05 BE13 18FF 2FC4 B4D6  95FB 145E 71F5 AED5 ABFB
```

Verify the fingerprint against this page before you trust the key — this docs site
is itself verifiable ([check the paint](/privacy/verify)), so a swapped key would
have to survive that too.

**Do not** post the details anywhere public — not Holler, not an issue, not a tweeted
proof-of-concept. A published deanonymization vector is an active danger to real
people who can't patch themselves. The Holler ping above is deliberately contentless
for exactly that reason: it says *that* you found something, never *what*.

## What we care about most

Ranked, honestly. These three classes get dropped-everything treatment.

### 1. Key custody

Anything that exposes, exfiltrates or weakens a user's tag secret. The secret is
generated in the browser and stored in IndexedDB; it is the user's entire identity
and there is no recovery if it leaks.

In scope and high value:

- XSS or script injection in the client — trivially becomes key theft here.
- Any path where a secret key, or a decrypted blackbook, leaves the device.
- Weaknesses in the NIP-49 blackbook encryption as we've implemented it: bad
  scrypt parameters, nonce reuse, weak randomness, a passphrase leaking into
  storage, logs or telemetry.
- Anything that lets one origin, extension or embedded resource read key material.
- Flaws in the QR handoff / device-linking flow.
- Weak or predictable key generation.

### 2. EXIF stripping and the media pipeline

The claim is that photo metadata is destroyed **on the device** before upload and
never reaches us. Break that claim and you've broken the most concrete privacy
promise on the site.

- Any file type, code path, browser or platform where original metadata survives
  the client re-encode and reaches the network. **Clips count** — the video path
  re-encodes with metadata mapping disabled, and anything surviving that is the same
  class of bug as surviving the image path.
- Any path where original bytes are persisted server-side rather than the
  re-encoded output.
- Bypasses of the server-side `sharp` (or `ffmpeg`) re-encode.
- Metadata reintroduced downstream — by thumbnailing, by anything we put in front of
  the origin later, by anything.
- **Face-blur failures that fail open**: a picture that uploads uncovered after the
  writer switched blurring on, a preview that doesn't match the uploaded bytes, or a
  covering that turns out to be recoverable rather than destructive.
- Content-addressing failures: served bytes that don't match the hash in the URL.

### 3. Deanonymization vectors

Anything that links a tag to a person, a device, a network location or another
identity.

- IP addresses appearing in any log, database column, error payload, backup or
  response header. The rule is zero, so any instance is a finding.
- Correlation attacks made possible by our own design: timing side channels,
  ordering leaks, an API that discloses more than the feed does.
- Third-party requests from the client — any outbound request to a domain we don't
  control is a bug by definition, since there's supposed to be none.
- Leaks in the [onion mirror](/privacy/onion): **any** clearnet resource loaded over
  the hidden service — the mirror is supposed to be complete now, so a single request
  to `1nky.com` from an onion session is a finding — plus differences between the two
  paths that fingerprint which one you came in on.
- Metadata leakage in the relay's responses beyond what's in the public event.
- Private-message leakage: a sender's real pubkey recoverable from the outside of an
  envelope, a message body reaching the index, correlating two envelopes as one
  conversation.
- Anything that distinguishes "this tag and that tag are the same person" — including
  through the crew keyring, the crew-key backup path, or the "posting as" overlay
  leaking which writer holds which crew.
- Recovery escrow: anything that makes a locked blackbook copy decryptable by us,
  enumerable by a stranger, or overwritable by somebody who isn't its owner.

### Also in scope, lower on the list

- Relay write-policy bypasses: publishing below the proof-of-work threshold,
  posting as a banned pubkey, forbidden kinds accepted, size caps evaded.
- Signature verification flaws — anything that lets an event be attributed to a
  pubkey that didn't sign it.
- Media service auth bypass: uploading without a valid kind-24242 event, deleting
  someone else's blob, hash confusion.
- Moderation bypass, ban evasion at the protocol level, mod-action forgery.
- Denial of service that's cheap for the attacker and expensive for us — storage
  amplification, relay resource exhaustion, cache poisoning. Please describe it
  rather than demonstrating it at scale.
- Infrastructure exposure: an admin surface reachable from the internet, a
  misconfigured bucket, secrets in a public artifact.
- This documentation site making a factual claim the code doesn't support. Yes,
  that counts as a security bug here.

## Out of scope

Not because they don't matter, but because reporting them wastes your time and
ours:

- Missing security headers with no demonstrated impact.
- Anything requiring a rooted/jailbroken device, a malicious browser extension the
  user installed, or full physical access to an unlocked device. If someone has
  your unlocked phone, they have your tag; that's inherent to client-held keys and
  it's documented, not a vulnerability.
- Social engineering of the operators, and physical attacks.
- Automated scanner output with no analysis attached.
- Missing rate limits with no demonstrated abuse path.
- "Users can post objectionable content" — that's moderation, use
  [Flag it](/feedback).
- Reports about third-party infrastructure (the static host, the hosting provider, the
  object-storage provider). Report those to them; we'll help coordinate if it involves
  our configuration.
- Self-dox risks that are behavioral rather than technical — a landmark visible in
  a photo isn't a platform bug. See [opsec](/privacy/opsec).

## Rules of engagement

Test against your own tags and your own content. Concretely:

- **Don't access, modify or exfiltrate other users' data.** If you stumble into
  someone else's data proving a bug, stop, don't save it, and say so in the report.
- **Don't degrade the service.** No load testing, no stress testing, no automated
  scanning against production. Ask us and we'll set something up.
- **Don't post illegal content, ever**, including as a test. There is no
  research exemption here and we will treat it as an attack.
- **Don't hold data hostage** or condition disclosure on payment. See the bounty
  section — there isn't one, and a report that arrives with a price attached gets
  treated as extortion rather than research.
- **Give us a window.** 90 days from acknowledgment, or until a fix is deployed,
  whichever comes first. We'll usually be much faster on the high-severity classes.

Act in good faith within these rules and we will not pursue or support legal action
against you for your research, and we'll say so publicly if anyone else tries to.

## What we'll do

1. **Acknowledge** — target 72 hours. If you don't hear back, ping again; a missed
   report is a failure on our side.
2. **Triage** — we'll tell you our severity assessment and reasoning, including
   when we disagree with yours.
3. **Fix** — critical issues in the three headline classes get worked immediately,
   ahead of every feature. Everything else gets a target date we'll actually share.
4. **Disclose** — we'll publish what happened once a fix is out. If a bug exposed
   users to real-world risk, we'll say so loudly rather than burying it, because a
   quiet fix for a deanonymization bug leaves people making decisions on bad
   information.
5. **Credit you** — see below.

## No bounty. Props instead.

**There is no bug bounty program.** No money, no swag, no points. This is a
low-budget operation whose entire cost model is "under fifty dollars a month," and
promising payouts we can't fund would be worse than saying this plainly.

What we do have:

**A props page.** 📋 Shipping with the public repo. Every researcher whose report
leads to a fix gets listed — handle of your choosing, the class of the bug, the
date. Or stay off it entirely; anonymity is kind of the point around here and
"anonymous" is a perfectly good entry.

**A real changelog entry** naming the finding, so your work is in the permanent
public record of the project rather than in a private thank-you email.

If a bounty program ever exists, it'll be announced here first, and it'll be funded
before it's announced.
