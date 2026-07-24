# Terms of use

::: danger DRAFT — pending counsel review
This is a working skeleton written by the people building the platform, not by
lawyers. It has not been reviewed by counsel and it is not in force. It is
published now so the rules are visible while they're still being written, and so
they can be argued with. Do not rely on it as a legal document.

**Last updated:** 2026-07-24 · **Status:** draft, not effective
:::

## 1. What 1NKY is

1NKY is a place to post photographs, run boards and talk with other people about
graffiti. It does not require an account, an email address or any personal
information to use.

There is no "user account" on 1NKY in the ordinary sense. Your identity — your
**tag** — is a cryptographic secret generated on your own device and held by you.
We do not have it, cannot recover it, and cannot use it. Everything in these terms
that would normally be phrased in terms of your account is instead phrased in terms
of your tag and the content you post with it.

## 2. Who can use it

You must be **18 or older** to use 1NKY. There is no age verification, because
verification would require collecting identity documents, which would destroy the
only thing that makes this platform worth running. So this is an honor rule with a
hard consequence: content we identify as belonging to, or depicting, a minor is
removed, and the tag is banned.

## 3. Zero tolerance: child sexual abuse material

**Any child sexual abuse material (CSAM), or any sexualized content involving
minors of any kind, is absolutely prohibited.** There are no exceptions, no
context, no artistic or research carve-out, and no appeal.

Where such content is identified:

- it is removed immediately;
- the associated tag is permanently banned;
- it is reported to the **NCMEC CyberTipline**, and the associated evidence is
  preserved, as required by 18 U.S.C. § 2258A and the REPORT Act;
- we will cooperate fully with law enforcement on it.

The privacy architecture described throughout these docs is real, and it does not
change this. We will report every instance we become aware of, using whatever we
have — which is the content itself and the public key that signed it. Anyone
counting on anonymity as cover for this should understand that we treat it as the
single thing we act on fastest, and that we designed the moderation tooling around
being able to.

Report it: use **Flag it** in the app, or the
[security contact](/security) if you cannot use the app.

## 4. Lawful use

**Graffiti photography and discussion are lawful.** People have publicly hosted
photographs of graffiti and written about the culture continuously since at least
1994. Documenting, discussing, critiquing and archiving the work is protected
expression, and that's what this platform is for.

That is a different thing from using the platform to plan or coordinate crimes. You
agree not to use 1NKY to:

- solicit, plan, coordinate or direct any criminal act;
- threaten, stalk, harass or incite violence against anyone;
- post anyone's private personal information ("doxxing") — including other writers,
  and including in the middle of beef;
- post content that infringes someone else's copyright (see the
  [DMCA policy](/legal/dmca));
- post spam, scams, malware, or commercial advertising;
- impersonate another writer with intent to deceive (note that tag names are not
  unique by design — see **marks** in [how it works](/how-it-works) — so
  impersonation is judged on intent and behavior, not on name collision alone);
- attack the platform: circumvent the write policy, evade a ban, scrape abusively,
  or degrade the service for others. Good-faith security research is welcome and
  governed by the [disclosure policy](/security) instead.

**Nothing here is legal advice about your own conduct.** Whether a given act of
writing is legal where you are is between you and your jurisdiction. We host
photographs and conversation; we don't host walls.

## 5. Your content

**You keep everything you make.** We claim no ownership of your photographs or
your words. There is no rights grab in this document, and there won't be one added
later — we don't have an advertising business or a licensing business to feed.

By posting, you grant 1NKY a non-exclusive, worldwide, royalty-free license to
host, store, cache, reproduce and display your content **for the sole purpose of
operating the platform** — serving it to other users, caching it at the CDN,
generating thumbnails, and keeping backups. This license ends when the content is
removed, subject to the caveat below.

You represent that you have the right to post what you post.

**A caveat about removal that we'd rather state than bury:** you can **buff** any
post and it will be removed from the relay and the index. But 1NKY is a public
platform. Anything that has been publicly visible may have been downloaded,
screenshotted, cached or archived by third parties, and neither you nor we can
reach those copies. Removal is real on our side and cannot be retroactive
everywhere.

## 6. Your tag is your responsibility

There is no password reset because there is nothing on our side to reset from.

- If you lose your device and your **blackbook**, your tag is gone permanently. We
  cannot recover it. Nobody can.
- If someone obtains your blackbook and passphrase, they are you as far as the
  platform can tell, and we have no way to distinguish them from you or to take the
  tag back for you.
- Back up your blackbook. Encrypt it. See [how it works](/how-it-works#your-blackbook).

We will never ask you for your blackbook, your passphrase, or the secret behind
your tag. Anyone who does is attacking you.

## 7. Moderation

We moderate. Anonymous does not mean unmoderated.

- Moderators may remove content and ban tags for violations of these terms.
- Moderation actions are themselves signed and auditable, so the moderation log
  can be inspected rather than taken on trust.
- Enforcement is applied to tags, not to people, because we have no idea who
  people are.
- We may act without prior notice where the content is illegal or presents an
  immediate risk.

There is no formal appeals process yet (📋 planned). Where an appeal path exists it
will be documented here.

## 8. Availability, and no warranty

1NKY is provided **"as is," with no warranty of any kind**, express or implied,
including merchantability, fitness for a particular purpose, and non-infringement.

Specifically, and unusually bluntly: we do not warrant that the service will be
available, that your content will be preserved, or that your tag will survive on
your device. Browsers evict storage. Phones die. Servers fail. **Back up your
blackbook.**

## 9. Limitation of liability

To the maximum extent permitted by law, 1NKY and its operators are not liable for
indirect, incidental, special, consequential or punitive damages, or for lost
content, lost tags, or loss of anonymity resulting from your own posting decisions.

Read the [opsec page](/privacy/opsec). The architecture protects you from us; it
cannot protect you from what you choose to put in a photograph.

## 10. Changes to these terms

Changes are published here, in a public repository with a full commit history, so
that every version of this document and every diff between versions is inspectable.
Material changes will be announced in the app. Continued use after a change means
you accept the revised terms.

## 11. Governing law, contact, entity

📋 TODO — pending entity formation and counsel review. The operating entity,
governing law, venue, and notice address will be stated here before public launch.

- Legal notices: TODO
- Copyright: see [DMCA](/legal/dmca)
- Security: see [responsible disclosure](/security)
- Everything else: see [feedback](/feedback)
