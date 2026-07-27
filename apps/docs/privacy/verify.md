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
from a specific, public commit. The build produces a **manifest**: a plain JSON
file listing the exact SHA-256 fingerprint of every file the site ships. For
now that manifest is unsigned — nothing cryptographically ties it to the build
yet, so getting it from the real releases page over a connection you trust is
the load-bearing step (more on that below). **Signed manifests and GitHub
provenance attestations are coming**; once they land, the chain from "this
commit" to "this manifest" will be provable too, and that caveat gets retired.

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
it, wrapped so the check itself stays on Tor — otherwise you're proving the
onion's bytes from a path that betrays the whole point of using it:

```sh
torsocks node verify-1nky.mjs dist-manifest.json http://<address>.onion
```

If you'd rather use a Tor HTTP proxy port than torsocks, the script honors
`HTTPS_PROXY` when you launch Node with `--use-env-proxy` (Node 24+):

```sh
HTTPS_PROXY=http://127.0.0.1:8118 node --use-env-proxy \
  verify-1nky.mjs dist-manifest.json http://<address>.onion
```

On Node 18–23 there's no built-in env-proxy flag, so use torsocks or an
external wrapper for that path. The script itself ships no SOCKS code — either
way the routing happens outside it, which keeps it short enough to read.

Matching hashes on both the clearnet site and the onion also proves nobody is
being handed a special, targeted build.

## Build it yourself and compare

If you'd rather not trust even GitHub's build servers — or the unsigned
manifest, while it's still unsigned — clone the repo, check out the release's
commit, build the web app, and hash the files yourself. When the build is
reproducible for that commit (same source in, same bytes out), you'll get the
same numbers that are in the manifest, and the whole chain from source to
served bytes is confirmed by you alone. If your hash differs from the
manifest's, treat it as a build-environment question first, not evidence of
tampering at the wire — and [tell us](/feedback) if it doesn't resolve.

## What a mismatch means

A `MISMATCH`, `MISSING`, or `UNLISTED` line means the site is serving something
that isn't in the published release. That can be an innocent timing window (a
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
- **The manifest is unsigned, for now.** Today nothing cryptographically ties
  the manifest to the build — it's a JSON file attached to a release, so getting
  it from the real releases page over a connection you trust is the
  load-bearing step. The fingerprint on the
  [security page](/security#contact) and the signed `security.txt` are anchors
  that don't depend on this page being honest. **Signed manifests and GitHub
  provenance attestations are coming**; once they land, even that assumption
  gets retired. Until then, building it yourself (above) removes the
  trust-the-manifest step entirely.
