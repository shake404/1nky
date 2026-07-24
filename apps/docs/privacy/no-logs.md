# No logs, by architecture

::: warning For the nerds
This page names real software, real config files and real protocol numbers,
because the point of it is that an auditor can check the claims. If you just want
the plain-language version, read [How it works](/how-it-works).
:::

"We don't log" is the cheapest sentence in tech. Everybody says it. The only
version worth anything is the one where the logging **can't** happen, and where you
can go look.

So here's the architecture, claim by claim, with the check next to each one.

## The claims

| # | Claim | Where it's enforced | How you check it |
|---|---|---|---|
| 1 | The web server writes no access logs | Caddy config has no `log` directive | Read the `Caddyfile` |
| 2 | No IP addresses in the database | Postgres schema has zero IP columns | `grep` the schema |
| 3 | No request logging in any service | Express apps ship no logging middleware | `grep` for `morgan` |
| 4 | Writes never touch the API | Writes are signed events straight to the relay | Watch your own devtools |
| 5 | No analytics, telemetry or cookies | None in the client, none on this docs site | Devtools → Network |
| 6 | No email, password or OAuth anywhere | Identity is a client-held keypair | There's no login form to find |

## 1. Caddy, with logging deliberately absent

Caddy 2 only writes access logs if you tell it to. Our vhost blocks contain no
`log` directive at all — not `log { output discard }`, which still runs the logging
pipeline, but *no logging block whatsoever*. There is no path, no file, no socket,
no journald sink where request lines exist.

```
# infra/caddy/Caddyfile — shape of it
1nky.com {
    header -Server
    # no log block. On purpose. Adding one is a bug, not a config change.
    handle /media/* { reverse_proxy media:8080 }
    handle /api/*   { reverse_proxy api:8080 }
    handle /relay   { reverse_proxy strfry:7777 }
    handle          { root * /srv/web; file_server }
}
```

The relay itself binds to loopback behind Caddy, so from strfry's point of view
every connection in the world originates from `127.0.0.1`. Even if it were chatty,
it has nothing interesting to be chatty about.

**Check it:** read [`infra/caddy/Caddyfile`](https://github.com/bodegga/1nky/tree/main/infra/caddy)
in the public repo and search it for the string `log`. If you find a logging block
in a deployed config, that's a disclosable finding — [tell us](/security).

## 2. Zero IP columns in the schema

The Postgres database is not the source of truth; it's a rebuildable index of
public signed posts. It stores post ids, author public keys, kinds, tags, content,
timestamps, counts. There is **no column, in any table, for an IP address** —
not plaintext, not hashed, not truncated, not "for rate limiting."

This one is easy to audit because a schema is a small, flat, greppable file:

```bash
git clone https://github.com/bodegga/1nky
cd 1nky

# every table definition in the indexer
grep -rn "CREATE TABLE" apps/indexer

# the interesting search: any hint of an address column, anywhere
grep -rniE "\b(ip_addr|ip_address|client_ip|remote_addr|x_forwarded|xff|user_agent|useragent)\b" \
  apps/ packages/ infra/
```

The second command is expected to return **nothing**. If it ever returns a hit in a
schema, a migration or a service, the hard rule has been broken and we want the
issue filed publicly.

Note what this rules out: there's no "we keep IPs for 30 days for security." There
is no retention window, because there is no field. A retention policy is a promise;
a missing column is a fact.

## 3. No request logging middleware in any service

The API, indexer and media services are Express apps with no `morgan`, no `pino-http`,
no access-log middleware of any kind. Error handlers are allowed to log an event id
or an event kind so we can debug a bad payload — never connection information.

```bash
grep -rn "morgan\|pino-http\|express-winston\|access.log" apps/ packages/
```

Expected output: nothing. And because there's no logging dependency, there's no
"someone flipped a verbosity env var in prod at 2am" failure mode either — the
package isn't installed.

## 4. Your posts don't go through our API

This is the structural part people miss. The REST API is **read-only**. It serves
feeds, search and board lists. It cannot accept a post, because posting isn't an
HTTP write in this system.

When you post, your device signs the event and opens a WebSocket to the relay
(strfry) to publish it. The relay verifies the signature and the proof-of-work,
then stores it. So the request path that would normally be the juiciest log source
in a social app — "user X posted Y at time Z from address W" — doesn't exist as an
HTTP transaction at all.

**Check it:** open devtools → Network → WS while you post. You'll see the signed
event go up the socket and you'll see no `POST /api/...` anywhere. Media upload is
the one write that is HTTP (`PUT` to the Blossom-compatible media service,
authorized by a signed kind-24242 event) and it too is logged nowhere.

## 5. No analytics, no telemetry, no cookies {#what-the-edge-sees}

The client ships no analytics SDK, no error-reporting SDK, no tag manager, no
fonts loaded from someone else's domain, and sets no tracking cookies. This
documentation site ships none either — search on this site is a local index built
at build time, not a hosted search service.

**Check it:** devtools → Network, hard reload, sort by domain. Every request should
be to a 1NKY-controlled hostname. Then devtools → Application → Cookies. Should be
empty.

### What Cloudflare sees at the edge

Here's the part where we don't pretend. On the clearnet site, Cloudflare sits in
front of us as CDN, cache and DDoS protection. That means:

- **Cloudflare terminates TLS**, so their edge processes your request, including
  your IP address, transiently, under their own privacy policy — not ours, and not
  under our control.
- **We chose that** on purpose: it's what makes content-addressed image serving
  cheap enough to run for pocket change, and Cloudflare's free CSAM Scanning Tool
  is part of how we keep the worst content off the platform.
- **It's a genuine wart.** We're not going to call a third party in the request
  path "zero knowledge."

Two things bound the damage. First, the origin keeps no logs regardless, so the CDN
edge is the *only* place a clearnet address exists, in someone else's infrastructure,
for someone else's retention window. Second — and this is the real answer — the
**.onion mirror bypasses Cloudflare entirely**, going straight to the origin over
Tor's hidden service protocol. No CDN, no TLS termination by a third party, no IP
at any hop that could be turned into a subpoena target.

The onion mirror is a Phase 4 deliverable and a launch-blocking feature, not a
someday. Until it's live, this page will say so. Status:
[see the roadmap](/roadmap#phase-4-hardening-sovereignty).

**Positioning, stated plainly:** clearnet is the convenient path, onion is the
sovereign path. Pick according to your threat model.

## 6. There is no account to compromise

No email, no password, no OAuth, no session tokens, no password reset, no "sign in
with." Identity is a secp256k1 keypair generated in your browser and held in
IndexedDB on your device. Server-side there is no user table, because there is no
user record to have — just public keys that showed up attached to signed events.

The classic breach story for a social platform is "attacker dumps the users table."
We don't have one.

## Verify it yourself

You don't need to trust a word above. In rough order of effort:

**Two minutes, no tools.** Open the app, open devtools, hit Network. Post something.
Watch where the bytes go. Look for third-party domains (there should be none) and
for cookies (there should be none). Look for the WebSocket carrying your signed
post rather than an HTTP write.

**Ten minutes, with `git`.** Clone the repo and run the greps in sections 2 and 3.
Read the Caddyfile. Read the indexer schema top to bottom — it's short. Read the
strfry config in `infra/` and confirm the relay binds loopback.

**Twenty minutes, with `exiftool`.** Post a photo that has GPS metadata in it, then
download the version the site serves back and run `exiftool` on it. Confirm the
metadata is gone — and confirm from the network tab that it was already gone in the
bytes that left your machine. Full walkthrough on the [opsec page](/privacy/opsec#verify-exif-stripping).

**Ongoing.** The repo is public and the commit history is public. A change that
adds a logging dependency, an IP column or an analytics script is visible in a
diff, forever, with a name on it.

::: info Repo status
The public GitHub mirror at `github.com/bodegga/1nky` goes online with launch.
Until then the links on this page 404 — we'd rather ship the page with the check
written down than describe the check vaguely. File paths above match the monorepo
layout described in the [technical page](/for-the-nerds).
:::

## Subpoena posture

Legal process gets a straight answer, so here it is in advance.

We will comply with valid legal process. The catch, for anyone hoping to use it, is
what compliance can produce:

**What we could hand over, because it exists:** the public content itself — the same
signed posts anyone can already read on the site — and the public key that signed
them. That's it. A public key is not a person; it's a number that was never linked
to a name, an email, a phone or an address on our side.

**What we could not hand over, because it was never collected:**

- IP addresses, current or historical. No log, no column, no backup containing one.
- Email addresses, phone numbers, real names — never requested, never stored.
- Passwords or password hashes — there are none.
- Session or login history — there are no sessions.
- Device identifiers, advertising IDs, fingerprints — not collected.
- Private keys. Not "we won't." We physically don't have them; they never left the
  user's device.

**We cannot produce what we never collected.** That's not a slogan, it's an
engineering property, and it's the whole reason the architecture looks the way it
does. A subpoena that arrives asking who posted a given flick gets an honest answer
of "a public key, here it is, we have no idea who holds it."

Where we're compelled to act rather than produce — a valid takedown order, for
instance — we can remove content from the relay and the index, and we'll note it in
the [transparency report](/privacy/transparency) to the extent we're legally
permitted to.

## If we ever break one of these

These aren't aspirations, they're the hard rules the codebase is reviewed against.
If a release violates one, the correct outcome is a public issue, a revert and a
note in the transparency log — not a quiet fix. Report it: [/security](/security).
