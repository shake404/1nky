#!/usr/bin/env node
/**
 * 1NKY strfry write-policy plugin.
 *
 * strfry spawns this as a stdio child process of the relay (see
 * relay.writePolicy.plugin in strfry.conf). It is NOT a compose service.
 *
 * PROTOCOL (docs/plugins.md in hoytech/strfry)
 *   stdin : one minified JSON object per line
 *           { type: "new", event: {...}, receivedAt, sourceType, sourceInfo, authed? }
 *   stdout: one minified JSON object per line
 *           { id: <event.id>, action: "accept" | "reject" | "shadowReject", msg?: <NIP-20 text> }
 *   The `id` MUST echo the input event's id. strfry currently waits for a
 *   response before sending the next request, but that is not guaranteed
 *   forever, which is why the id is required.
 *
 * NO-LOGS (CLAUDE.md hard rule #1)
 *   The ONLY thing this process ever writes to stderr is:
 *       kind=<n> accept
 *       kind=<n> reject
 *   No pubkeys. No event ids. No content. No sourceInfo — which is where
 *   strfry would put the client IP if relay.realIpHeader were set, and it
 *   isn't. This file must never grow a debug logger. The rejection *reason*
 *   travels to the client in the NIP-20 `msg` field, which is a response, not
 *   a record.
 *
 * DEPENDENCIES
 *   None. Node core only, and only Node 18+ APIs, because the relay image is
 *   Alpine 3.18 (nodejs 18.x). See infra/docker/strfry.Dockerfile.
 *
 * CONFIG (env, inherited from the strfry container)
 *   ALLOWED_KINDS       csv of integer kinds. default 0,1,5,20,1111,1984,10000,30078
 *   MAX_EVENT_BYTES     default 65536
 *   POW_ENABLED         "0" disables the PoW gate entirely (local dev). default on
 *   POW_BITS_NEW        default 18  — first event seen from a pubkey, and POW_NEW_KINDS
 *   POW_BITS_POST       default 13  — everything else
 *   POW_BITS_REACTION   default 8   — POW_REACTION_KINDS
 *   POW_NEW_KINDS       default 0
 *   POW_REACTION_KINDS  default 1984,10000
 *   BAN_LIST_PATH       default /app/plugin/banlist.json — JSON array of hex pubkeys
 */

import { readFileSync, statSync } from 'node:fs';

/* ------------------------------------------------------------------ config */

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const kindSet = (name, fallback) => {
  const raw = process.env[name] ?? fallback;
  const out = new Set();
  for (const part of String(raw).split(',')) {
    const n = Number.parseInt(part.trim(), 10);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
};

const ALLOWED_KINDS = kindSet('ALLOWED_KINDS', '0,1,5,20,1111,1984,10000,30078');
const NEW_KINDS = kindSet('POW_NEW_KINDS', '0');
const REACTION_KINDS = kindSet('POW_REACTION_KINDS', '1984,10000');

const MAX_EVENT_BYTES = num('MAX_EVENT_BYTES', 65536);
const POW_ENABLED = (process.env.POW_ENABLED ?? '1') !== '0';
const POW_BITS_NEW = num('POW_BITS_NEW', 18);
const POW_BITS_POST = num('POW_BITS_POST', 13);
const POW_BITS_REACTION = num('POW_BITS_REACTION', 8);
const BAN_LIST_PATH = process.env.BAN_LIST_PATH || '/app/plugin/banlist.json';

/* --------------------------------------------------------------- ban list */

/**
 * Hot-reloaded from BAN_LIST_PATH. Phase 2 wires the mod queue's takedown+ban
 * button to rewrite that file (Postgres table -> JSON, per handoff Part 6);
 * this side just has to notice. We stat() at most once per second so a busy
 * relay does not syscall itself to death, and we reload on any mtime/size
 * change. A malformed or missing file keeps the last good list rather than
 * failing open to "nobody is banned" or closed to "everybody is banned".
 */
const banned = {
  set: new Set(),
  checkedAt: 0,
  mtimeMs: -1,
  size: -1,
};

const RELOAD_THROTTLE_MS = 1000;

function refreshBanList() {
  const now = Date.now();
  if (now - banned.checkedAt < RELOAD_THROTTLE_MS) return;
  banned.checkedAt = now;

  let st;
  try {
    st = statSync(BAN_LIST_PATH);
  } catch {
    // File not present yet. Keep whatever we already have.
    return;
  }
  if (st.mtimeMs === banned.mtimeMs && st.size === banned.size) return;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(BAN_LIST_PATH, 'utf8'));
  } catch {
    // Half-written or invalid JSON. Do NOT update the stat fingerprint, so we
    // retry on the next tick once the writer finishes.
    return;
  }
  if (!Array.isArray(parsed)) return;

  const next = new Set();
  for (const entry of parsed) {
    // Accept both ["<hex>"] and [{ pubkey: "<hex>", ... }] shapes so the Phase 2
    // exporter can carry metadata (reason, expiry) without breaking us.
    const pk = typeof entry === 'string' ? entry : entry && entry.pubkey;
    if (typeof pk === 'string' && /^[0-9a-f]{64}$/i.test(pk)) next.add(pk.toLowerCase());
  }

  banned.set = next;
  banned.mtimeMs = st.mtimeMs;
  banned.size = st.size;
}

/* -------------------------------------------------------------- NIP-13 PoW */

/**
 * Count leading zero bits of a 32-byte hex event id.
 * Each hex nibble is 4 bits; Math.clz32 on a 1..15 value returns 31..28, so
 * (clz32(n) - 28) is the number of leading zero bits inside that nibble.
 */
function leadingZeroBits(hexId) {
  if (typeof hexId !== 'string') return 0;
  let bits = 0;
  for (let i = 0; i < hexId.length; i++) {
    const nibble = Number.parseInt(hexId[i], 16);
    if (!Number.isFinite(nibble)) return bits;
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    return bits + (Math.clz32(nibble) - 28);
  }
  return bits;
}

/**
 * The committed-target rule from NIP-13.
 *
 * A `["nonce", "<counter>", "<target>"]` tag lets the miner state the
 * difficulty it was aiming for. Without it, an attacker can grind ordinary
 * cheap events and publish whichever one happens to land a few lucky zeros —
 * free difficulty. So we require BOTH:
 *
 *   1. a committed target >= the difficulty we demand, and
 *   2. an actual id whose leading zero bits meet that committed target.
 *
 * Returns null on success, or a NIP-20 rejection message.
 */
function checkPow(event, required) {
  if (required <= 0) return null;

  const actual = leadingZeroBits(event.id);

  let committed = null;
  if (Array.isArray(event.tags)) {
    for (const tag of event.tags) {
      if (Array.isArray(tag) && tag[0] === 'nonce') {
        const c = Number.parseInt(tag[2], 10);
        if (Number.isFinite(c)) committed = c;
        break; // first nonce tag wins, matching strfry's own tag handling
      }
    }
  }

  if (committed === null) {
    return `pow: missing committed difficulty; add a nonce tag targeting ${required} bits`;
  }
  if (committed < required) {
    return `pow: committed difficulty ${committed} is below the required ${required}`;
  }
  if (actual < committed) {
    return `pow: difficulty ${actual} does not meet the committed target ${committed}`;
  }
  return null;
}

/**
 * Which PoW tier applies.
 *
 * Phase 0+ approximation of "first-ever event from a pubkey": we remember
 * pubkeys we have accepted in this process. It resets when the relay (and
 * therefore the plugin) restarts, which makes it a speed bump rather than a
 * wall — that is the intended Phase 0/1 shape. Phase 2 replaces `seen` with
 * the indexer's pubkey-reputation table (age of first event, post count,
 * report count) per handoff Part 6.
 */
const seen = new Set();
const SEEN_CAP = 200000; // bounded so a spam flood cannot grow us unbounded

function requiredBits(kind, pubkey) {
  if (REACTION_KINDS.has(kind)) return POW_BITS_REACTION;
  if (NEW_KINDS.has(kind)) return POW_BITS_NEW;
  if (!seen.has(pubkey)) return POW_BITS_NEW;
  return POW_BITS_POST;
}

/* ------------------------------------------------------------------ policy */

function decide(req) {
  const event = req && req.event;
  if (!event || typeof event.id !== 'string') {
    return { action: 'reject', msg: 'invalid: malformed event' };
  }

  const kind = Number(event.kind);
  const pubkey = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : '';

  // 1. Kind allowlist. Everything the product does not use is refused at the
  //    door so the relay never becomes a general-purpose dumping ground.
  if (!ALLOWED_KINDS.has(kind)) {
    return { action: 'reject', msg: `blocked: kind ${kind} is not accepted here` };
  }

  // 2. Ban list, hot-reloaded. Checked before PoW so a banned pubkey's mined
  //    work is wasted and the rejection is instant (Phase 2 acceptance: banned
  //    pubkey rejected at relay in <1s).
  refreshBanList();
  if (banned.set.has(pubkey)) {
    return { action: 'reject', msg: 'blocked: this tag is banned' };
  }

  // 3. Size cap. strfry enforces events.maxEventSize itself, but doing it here
  //    too keeps the client-facing message consistent and covers the case where
  //    the two limits drift apart.
  const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
  if (bytes > MAX_EVENT_BYTES) {
    return { action: 'reject', msg: `invalid: event is ${bytes} bytes, limit is ${MAX_EVENT_BYTES}` };
  }

  // 4. NIP-13 proof of work. This is the CAPTCHA — there are no accounts, so
  //    there is no signup friction for bots either.
  if (POW_ENABLED) {
    const need = requiredBits(kind, pubkey);
    const failure = checkPow(event, need);
    if (failure) return { action: 'reject', msg: failure };
  }

  if (pubkey) {
    if (seen.size >= SEEN_CAP) seen.clear();
    seen.add(pubkey);
  }

  return { action: 'accept' };
}

/* -------------------------------------------------------------------- main */

function respond(id, verdict, kind) {
  const out = { id, action: verdict.action };
  if (verdict.action === 'reject' && verdict.msg) out.msg = verdict.msg;
  process.stdout.write(JSON.stringify(out) + '\n');
  // The one and only log line. Kind + decision. Nothing else, ever.
  process.stderr.write(`kind=${kind} ${verdict.action}\n`);
}

let buffer = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;

    let req;
    try {
      req = JSON.parse(line);
    } catch {
      // Unparseable line: we have no id to echo, so there is nothing strfry
      // could correlate a response to. Drop it silently (logging it would mean
      // logging attacker-controlled bytes).
      continue;
    }

    const id = req && req.event && req.event.id;
    if (typeof id !== 'string') continue;

    const kind = req.event && req.event.kind;

    // `type` is currently always "new". If strfry ever introduces another
    // request type, default to accepting so an upgrade cannot silently start
    // dropping every write — the checks above still run for real "new" events.
    if (req.type !== 'new') {
      respond(id, { action: 'accept' }, kind);
      continue;
    }

    let verdict;
    try {
      verdict = decide(req);
    } catch {
      // Never wedge the relay on our own bug. Fail closed on the single event.
      verdict = { action: 'reject', msg: 'error: policy check failed, try again' };
    }
    respond(id, verdict, kind);
  }
});

process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));

// Prime the ban list at startup so the very first event is checked against a
// real list rather than an empty one.
refreshBanList();
banned.checkedAt = 0;
