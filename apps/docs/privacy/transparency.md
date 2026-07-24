# Transparency & warrant canary

Two commitments live on this page: a **warrant canary** we update on a schedule,
and an **annual transparency note**. Both exist so that the absence of bad news is
verifiable rather than assumed.

## Warrant canary

::: danger Read the date, not the words
A canary is only meaningful if you check when it was last updated. If the date
below is more than 45 days stale, treat the canary as **failed** and act
accordingly — do not wait for an announcement, and do not accept an explanation
that the update was "just delayed."
:::

> **1NKY warrant canary — as of 2026-07-24**
>
> As of the date above, 1NKY has received:
>
> - **0** subpoenas for user information
> - **0** search warrants
> - **0** court orders of any kind
> - **0** National Security Letters
> - **0** FISA court orders or directives
> - **0** gag orders or non-disclosure orders
> - **0** requests from any government for user data, formal or informal
> - **0** requests to modify, backdoor, or weaken any part of the platform
> - **0** requests to preserve user data pending legal process
>
> 1NKY has never turned over user data to any party.
> No searches or seizures of 1NKY servers or infrastructure have occurred.
> 1NKY remains under the control of its stated operators and has not been the
> subject of an acquisition, forced sale, or change of control.
>
> This statement is current as of **2026-07-24** and will be reissued on or before
> **2026-09-07**. The next scheduled reissue date is always stated in the statement
> itself.
>
> *Signature: TODO — canary statements will be cryptographically signed by the
> 1NKY site key once that key is published. Until then this canary is
> unauthenticated and should be weighted accordingly.*

### Pre-launch status

1NKY is not publicly launched yet. The zeros above are true and also easy to
achieve, since there are no users to receive requests about. The canary is
published now so that the format, the cadence and the reissue commitment are on the
record *before* the first request ever arrives — a canary introduced after the fact
is worth very little.

### How the canary works

**Cadence.** Reissued at least every 45 days. Each statement names its own next
reissue date, so you never have to guess what "on time" means.

**Failure.** If a statement is not reissued by its stated date, the canary has
failed. We may be legally unable to tell you why, which is the entire point of the
mechanism. A failed canary is not proof of a specific event; it's a signal to stop
assuming the zeros still hold.

**No silent edits.** Canary text is versioned in the public docs repository. Every
change to this page is a commit with a timestamp and a diff. You can read the whole
history rather than trusting the current rendering.

**Signing.** TODO. Once the site key is published, each canary statement will be
signed with it so a canary can't be forged by whoever controls the domain or the
hosting account. Until that ships, this page's authenticity rests on the docs repo
history and TLS, and we're saying so plainly rather than implying more.

## Annual transparency note

Every calendar year, on or about **1 February**, we publish a transparency note
covering the prior year. Committed contents:

- **Legal process received**, by category and count: subpoenas, warrants, court
  orders, preservation requests, emergency disclosure requests, NSLs (to the extent
  reportable), foreign government requests.
- **What we produced in response**, by category — including, we expect, a lot of
  "nothing responsive existed."
- **Takedown demands**: DMCA notices and counter-notices received and acted on,
  plus non-DMCA removal demands.
- **Content removed by us**, in aggregate: moderation takedowns and bans by reason
  category.
- **CSAM reports** filed to the NCMEC CyberTipline, in aggregate count. Reporting is
  a legal obligation once we have actual knowledge, and we treat it as
  non-negotiable.
- **Security incidents** affecting user data or platform integrity, and what we did.
- **Infrastructure and architecture changes** that affect the privacy claims on
  these docs — for example, adding or removing a third party from the request path.

The note will state its own limitations. Where the law prohibits us from disclosing
a category, we'll say that a prohibition exists to the extent we're permitted to,
rather than reporting a misleading zero.

First note: February 2027, covering the period from launch.

## What we would have to comply with

We're a US-connected operation and we're not pretending to be beyond the reach of
law. Straight answers:

**Valid legal process gets a response.** A properly issued subpoena, warrant or
court order with jurisdiction over us gets reviewed — by counsel, once counsel is
engaged — and complied with where valid. We will push back on overbroad,
defective or improperly served demands, and we'll seek to notify affected users
where we're legally permitted to do so and where notification is technically
possible. Note the second qualifier: with no email addresses on file, "notify the
user" usually means a public notice on this page, because that's the only channel
we have.

**Valid takedown orders get honored.** Court-ordered removals, and DMCA notices
that meet the statutory requirements, are processed through the
[DMCA flow](/legal/dmca).

**CSAM gets reported.** Once we have actual knowledge, we report to the NCMEC
CyberTipline and preserve the evidence bundle as required. Zero tolerance, no
discretion, no exceptions, and it is the one area where we will act faster than any
legal process requires.

**Emergency requests** involving an imminent risk of death or serious injury get
reviewed immediately on their merits. We'll disclose whatever we actually have,
which — see below — is very close to nothing.

## What we cannot produce

Not "will not." Cannot. This isn't policy, it's the shape of the system, documented
with verification steps on the [no-logs page](/privacy/no-logs).

| Requested | Status |
|---|---|
| IP addresses (current or historical) | Never collected. No log, no column, no backup. |
| Email addresses | Never collected. There's no field for one anywhere. |
| Phone numbers | Never collected. |
| Real names, billing details, payment methods | Never collected. Nothing is sold. |
| Passwords / password hashes | Do not exist. There is no password system. |
| Login or session history | Do not exist. There are no sessions. |
| Device identifiers, ad IDs, fingerprints | Not collected. |
| Private keys / the ability to post as a user | Physically impossible — keys never leave the user's device. |
| Ability to decrypt a user's blackbook | Physically impossible — passphrase is never transmitted. |
| Analytics or behavioral profiles | Do not exist. No analytics of any kind is deployed. |

**What does exist and could be produced:** the public content itself — the same
signed posts anyone can read on the site — and the public key that signed them. A
public key is a number with no identity attached to it on our side.

**Third parties are not covered by this table.** Cloudflare sits at the edge of the
clearnet site and processes visitor IPs transiently under their own policies; they
can receive legal process independently of us, and we have no visibility into or
control over that. Same for any hosting provider, which knows we rent a server. The
onion mirror exists precisely so there's a path with no third party in it. We'd
rather tell you where the seams are than claim there aren't any.

**We cannot produce what we never collected.** That sentence is the entire product
strategy, and the [verification section](/privacy/no-logs#verify-it-yourself)
exists so it isn't just a sentence.

## Contact

Legal process, transparency questions and press: contact details go live with
launch (TODO — placeholder pending entity formation and counsel review).
Security vulnerabilities go through [responsible disclosure](/security) instead.
