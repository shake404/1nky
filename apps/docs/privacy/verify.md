# Check the paint yourself

You don't have to take our word that the app you're running is the app we
published. You can check it — on your own machine, in about a minute, without
trusting this page while you do it.

## Why this is the thing that matters

Everything that could burn you happens in the app on your phone, not on our
box. Your tag is made there. Your photos have their location and camera details
stripped there, before anything leaves. Your messages are sealed there. The
server was never trusted with any of it — that's the whole design (see
[no logs](/privacy/no-logs)).

So the question that actually matters isn't "do you trust their server." It's
"is the app I'm running the real one, or has it been swapped for one that
quietly keeps a copy?" That question you can answer yourself.

## How

Every release we cut is built by GitHub's own servers — not on anyone's laptop —
from a specific, public commit. The build produces a **manifest**: the exact
SHA-256 fingerprint of every file the site ships. GitHub also signs a
**provenance attestation** — a cryptographic receipt that says "these files came
from this commit, built by this workflow." Neither of those can be forged
without GitHub's signing keys.

To check that **1nky.com** is serving exactly that:

1. Grab the manifest from the release you want to check —
   [the releases page](https://github.com/shake404/1nky/releases) has
   `dist-manifest.json` on each one.
2. Grab the checker (it's tiny, and has zero dependencies — read it first if you
   like, it's short): [`verify-1nky.mjs`](/verify-1nky.mjs).
3. Run it with Node 18 or newer:

```sh
node verify-1nky.mjs dist-manifest.json
```

Good output ends with:

```text
VERIFIED  42/42 files match, and the app shell loads nothing unlisted.
1nky.com is serving exactly the code v2026.07.26 published.
```

That means every file your browser would download from 1nky.com is
byte-for-byte the file that public commit builds to, and the app pulls in
nothing that isn't on the list.

## Checking over Tor

The [onion mirror](/privacy/onion) serves the same build. Point the checker at
it, wrapped so the check itself stays on Tor:

```sh
torsocks node verify-1nky.mjs dist-manifest.json http://<address>.onion
```

Matching hashes on both the clearnet site and the onion also proves nobody is
being handed a special, targeted build.

## Build it yourself and compare

The build is **reproducible** — building the same commit twice produces the
byte-identical result (we check this; it holds). So if you'd rather not trust
even GitHub's build servers, clone the repo, check out the release's commit,
build the web app, and hash the files yourself. You should get the same numbers
that are in the manifest. If you do, the whole chain — source to served bytes —
is confirmed by you alone.

## What a mismatch means

A `MISMATCH`, `MISSING`, or `UNLISTED` line means the site is serving something
that isn't in the signed release. That can be an innocent timing window (a
deploy in progress) — or it can be exactly the thing this page exists to catch.
Either way: **stop, don't post anything sensitive, and tell us** through any
channel on the [security page](/security). Re-run in a few minutes; if it's still
wrong, treat it as real.

## What this does *not* prove

Be clear about the edges:

- **It checks the client, not the server.** It proves the code in your hand is
  the published code. It cannot, by itself, prove what the server does with a
  request after it arrives — that rests on the architecture (no accounts, no IP,
  no logs — see [no logs](/privacy/no-logs)) and the fact that the client hands
  the server nothing identifying in the first place.
- **It trusts the release's signing chain.** The provenance attestation is only
  as good as GitHub's signing infrastructure. Building it yourself (above)
  removes even that assumption.
- **The manifest is the reference.** Verify you got it from the real releases
  page over a connection you trust; the fingerprint on the
  [security page](/security#contact) and the signed `security.txt` are anchors
  that don't depend on this page being honest.
