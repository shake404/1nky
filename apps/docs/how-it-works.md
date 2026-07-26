# How it works

No jargon on this page. If you want the protocol names, the version numbers and
the parts an auditor cares about, that's [For the nerds](/for-the-nerds). If you
just want to know where the buttons are, that's the guide:
[your tag](/guide/your-tag), [posting](/guide/posting), [boards](/guide/boards),
[crews](/guide/crews), [talking](/guide/talking),
[moderation](/guide/moderation), [installing it](/guide/install).

This page is the *why underneath* all of that.

## Your tag is made on your device

When you pick a tag, your browser generates a secret number — a cryptographic
identity — and stores it locally on that device. It never gets sent to us. There's
no moment in the process where a server hands you an account, because there is no
account.

That secret is what makes your posts yours. Two things come out of it:

- a **secret half** that stays in your pocket and is used to put your stamp on
  things, and
- a **public half** that everyone can see, which is how the world checks the stamp.

You never have to look at either one. In the app you just see your tag name.

::: tip Under a minute
Land on the site → PICK A TAG → type a name → you're posting. No email, no phone,
no CAPTCHA, no confirmation link, no terms-of-service wall.
:::

## Every post carries your stamp

When you post a flick or drop a comment, your device attaches a mathematical
signature to it before it leaves. Anyone — us, another writer, a stranger with a
laptop — can check that signature against the public half of your tag and confirm
two things:

1. this post came from the holder of that tag, and
2. not one character of it has been changed since.

That's the entire trust model. There's no password check, no session cookie, no
"logged in as." Authorship is proven by math on every single post, every time.

The useful consequence: **we can't post as you, and we can't stop you from proving
you posted something.** Moderators can remove content from 1NKY, but nobody can
forge your name onto a post, ever.

That one property is what everything else is built out of. A **crew** is a tag more
than one person holds, so a crew post is stamped by the crew rather than by any
member. A crew's **roster** is stamped by the crew, which is why it means something
that a writer merely saying they rep the crew doesn't. **Getting put on** is one
writer's stamp vouching for another. A moderator's ban is a stamp too. None of it
needs an accounts table, because a stamp anybody can check is stronger than a row in
a database anybody can edit.

## Why the server can't identify you

The server's job is to hold signed posts and hand them back out. To do that, it
needs the public half of your tag and the post itself. It does not need — and does
not get — an email, a phone number, a name, a device ID, or a location.

It also doesn't keep the one thing that usually burns people: **connection records.**
Request logging is switched off at the web server, and the database has no field
anywhere for an IP address. That isn't a policy we promise to follow; it's a shape
the system was built in. The [no-logs page](/privacy/no-logs) shows you where to
look.

So the honest answer to "what could 1NKY tell the police about me?" is: your tag's
public half, and the posts you already made in public. That's the whole file.

There's one path where even less exists: the [onion mirror](/privacy/onion). The
whole app is served over a Tor address, which means no other company is in the
request path at all — no content network, no certificate authority, not even a DNS
lookup saying you were curious about a graffiti site.

## Messages nobody can read

Public posts are public — that's the point of them. **Word**, the private-message
side, works the other way round.

A message is sealed between your device and theirs. What our box holds is an
envelope signed by a throwaway name, addressed to the recipient, with the time
deliberately smeared by up to two days. So the most our side can say is *"somebody
sent something to this tag at some point in the last 48 hours."* Not who, not when,
not what. [More on that.](/guide/talking#messages)

## Same name, different mark = different writer

Tag names are not unique and they can't be — there's no registrar, and adding one
would mean building the exact account system we refuse to build. Two people can
absolutely both call themselves the same thing.

So every tag also shows a short **mark**: a six-character fingerprint of your
public half, plus a little generated glyph, displayed right next to the name.

- Same name **and** same mark → same writer.
- Same name, **different mark** → different writer. Somebody's biting, or worse.

Learn to read the mark, not the name. It's the only part that can't be copied.

## Your blackbook

Your tag lives on your device, which means the device is the single point of
failure. Phones get lost. Browsers clear storage. iPhones are especially rude about
this — Safari will throw away a site's local storage after about a week of not
opening it, unless the site is installed to your home screen.

Your **blackbook** is the fix: a one-tap export of your tag, protected by a
passphrase you choose, saved as a file and shown as a QR code you can screenshot or
print.

- **Back it up right after your first post.** The app will nag you. Let it.
- **Install to your home screen** if you're on iOS. Installed apps are exempt from
  the storage cleanup that wipes ordinary tabs. [How.](/guide/install)
- **Second device?** Setup → Link a device, then read the block on the other device
  and enter the passphrase. Same tag, two devices.
  [Step by step.](/guide/your-tag#two-devices-one-tag)
- **Lost the device but kept the blackbook?** Restore it and you're back, same
  name, same mark, same history.
- **Want a belt as well as braces?** Setup → Recovery leaves a locked spare copy on
  our box. We hold the locked file; the passphrase never leaves your device, so we
  can't open it and neither can anybody who asks us to. It's off unless you turn it
  on. [Details.](/guide/your-tag#recovery-optional-off-by-default)

> Lose your blackbook, lose your tag. Nobody can recover it. Not even us.
> Especially not us.

That last line is not a customer-service dodge. There is no reset link because
there is nothing on our side to reset from — we never had your secret. That's the
same property that makes the platform safe for you; it just cuts both ways.

## Hanging it up

Writers retire names. When you're done with a tag you can **hang it up**: you type
the name to arm it, the app takes down everything it can find under that tag —
what the device remembers *and* what it can enumerate off the wall, tallying as it
goes — puts up one last note saying the tag is hung up, and then forgets the tag
entirely. It's a ritual, not an error state.

What it can't do is un-ring a bell. Anything already screenshotted, mirrored, or
cached elsewhere is out of everyone's hands, including ours.

## Where to go next

- [Using it](/guide/your-tag) — the guide, starting with your tag.
- [The onion mirror](/privacy/onion) — the whole app over Tor, and why you'd bother.
- [No logs, by architecture](/privacy/no-logs) — the claims, and how to check them.
- [Opsec for writers](/privacy/opsec) — how people actually get caught, and how not to.
- [For the nerds](/for-the-nerds) — protocols, kinds, and what we deliberately didn't build.
