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
| 7 | We can't read private messages | Sealed on the sender's device; never indexed | Send one, read the socket frame |
| 8 | The onion path has no third party in it | Hidden service straight to the origin | Load it in Tor Browser |

## 1. Caddy, with logging deliberately absent

Caddy 2 only writes access logs if you tell it to. Our vhost blocks contain no
`log` directive at all — not `log { output discard }`, which still runs the logging
pipeline, but *no logging block whatsoever*. There is no path, no file, no socket,
no journald sink where request lines exist.

```
# infra/caddy/Caddyfile — shape of it
api.1nky.com {
    header -Server
    # no log block. On purpose. Adding one is a bug, not a config change.
    handle /relay   { reverse_proxy strfry:7777 }
    handle /api/*   { reverse_proxy api:3001 }
    handle /media/* { reverse_proxy media:3002 }
}

:8080 {            # the .onion vhost — same routes, plus the app itself
    header -Server
    # no log block here either. Same rule, no exceptions.
    handle /relay   { reverse_proxy strfry:7777 }
    handle /api/*   { reverse_proxy api:3001 }
    handle /media/* { reverse_proxy media:3002 }
    handle          { root * /srv/web; file_server }
}
```

Two more deliberate absences in that file, both of which would undo the point:
there is no `metrics` endpoint (per-path request counters are telemetry by another
name), and no `X-Real-IP` / `X-Forwarded-For` plumbing to any upstream. strfry's
`realIpHeader` is set to the empty string, so it would ignore one anyway.

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

## 5. No analytics, no telemetry, no cookies

The client ships no analytics SDK, no error-reporting SDK, no tag manager, no
fonts loaded from someone else's domain, and sets no tracking cookies. This
documentation site ships none either — search on this site is a local index built
at build time, not a hosted search service.

**Check it:** devtools → Network, hard reload, sort by domain. Every request should
be to a 1NKY-controlled hostname. Then devtools → Application → Cookies. Should be
empty.

### Who else is in the request path {#what-the-edge-sees}

Here's the part where we don't pretend. There are two ways into 1NKY and they have
different shapes.

**Clearnet (`1nky.com`).** The app shell — HTML, JavaScript, the icons — is static
files served by a commercial static host. Everything that matters (the wall, media,
posting, messages) goes to **our own box**, directly, over a certificate we get
ourselves. So:

- **The static host sees requests for the app shell**, including the address they
  came from, transiently and under their own policies — not ours, and not under our
  control. What they serve is the same files for everybody, with nothing in them
  about you.
- **Our box sees the real traffic and keeps nothing** — no logs, no IP columns, per
  everything above on this page.
- **Your DNS resolver and your ISP see that you looked up 1nky.com.** That's true of
  every website, and it's the hop that a lot of people actually care about.
- **There is currently no content network in front of us**, so no third party
  terminates TLS on the traffic that matters. That's also why bandwidth is the
  cheapest thing about this operation and why one is
  [likely to be added](/roadmap#not-yet) — the free child-safety scanning tooling we
  need before a public launch comes attached to one. When that changes, this
  paragraph changes with it, before the change ships.

**The onion mirror.** The [full app over a Tor address](/privacy/onion): no static
host, no content network, no certificate authority, no DNS lookup, and nothing at any
hop that could become a subpoena target. Posting, pictures, messages — all of it, on
the one address.

**Positioning, stated plainly:** clearnet is the convenient path, onion is the
sovereign path. Pick according to your threat model. Neither one costs you your tag —
it's the same name and the same wall either way.

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

::: info Repo status — read this before you try the greps
**The code is not public yet.** The links to `github.com/bodegga/1nky` on this page
404 today, and the `git clone` above won't work. That's the biggest thing still owed
to anybody reading these pages sceptically, and it's on the
[roadmap](/roadmap#not-yet).

We publish the checks anyway, with the exact commands, because a check written down
in advance is one we can be held to — and because the checks that *don't* need the
repo (devtools, `exiftool`, watching your own network tab) work right now, today, and
they cover the claims that matter most. File paths above match the monorepo layout
described in the [technical page](/for-the-nerds).
:::

## Subpoena posture

Legal process gets a straight answer, so here it is in advance.

We will comply with valid legal process. The catch, for anyone hoping to use it, is
what compliance can produce:

**What we could hand over, because it exists:** the public content itself — the same
signed posts anyone can already read on the site — and the public key that signed
them. That's it. A public key is not a person; it's a number that was never linked
to a name, an email, a phone or an address on our side.

**One thing to declare, for writers who opted in:** if you switched on
[Recovery](/guide/your-tag#recovery-optional-off-by-default), we hold an encrypted
copy of your blackbook, keyed to your own public half. It's off by default, and the
passphrase never reaches us — so what could be handed over is a blob nobody can open,
including us. We list it here rather than leaving it out, because a privacy page that
omits the one thing we store is worthless.

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
