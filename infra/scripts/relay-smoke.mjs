#!/usr/bin/env node
/**
 * 1NKY Phase 0 relay acceptance test.
 *
 *   cd infra/scripts && pnpm install && node relay-smoke.mjs
 *
 * Handoff Part 7, Phase 0 acceptance:
 *   "docker compose up -> all healthy; nak (or ws script) can publish/query an
 *    event against local strfry."
 *
 * This is that script, plus it exercises the write policy, because a relay that
 * accepts everything is not the relay we are shipping.
 *
 * WHAT IT CHECKS
 *   1. websocket connects
 *   2. NIP-11 relay info is served over HTTP (name/nips)
 *   3. kind 0 profile, mined to POW_BITS_NEW  -> accepted
 *   4. kind 1 note,    mined to POW_BITS_POST -> accepted
 *   5. REQ by id round-trips the kind 1 back  -> EVENT then EOSE
 *   6. kind 1 with no proof of work           -> REJECTED (pow gate works)
 *   7. kind 9999 mined to full difficulty     -> REJECTED (kind allowlist works)
 *
 * ENV
 *   RELAY_WS_URL       default ws://127.0.0.1:7777
 *                      through Caddy instead: RELAY_WS_URL=ws://127.0.0.1/relay
 *   POW_BITS_NEW       default 18   must match the strfry container's env
 *   POW_BITS_POST      default 13
 *   POW_ENABLED        default 1    set 0 if you disabled the gate in compose
 *
 * Exits 0 on success, 1 on any failure.
 *
 * PRIVACY NOTE: this script generates a throwaway keypair every run and never
 * writes it anywhere. It prints event ids (public data) but no secret key.
 */

import WebSocket from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey, getEventHash } from 'nostr-tools/pure';

const RELAY_WS_URL = process.env.RELAY_WS_URL || 'ws://127.0.0.1:7777';
const POW_BITS_NEW = Number.parseInt(process.env.POW_BITS_NEW || '18', 10);
const POW_BITS_POST = Number.parseInt(process.env.POW_BITS_POST || '13', 10);
const POW_ENABLED = (process.env.POW_ENABLED || '1') !== '0';
const TIMEOUT_MS = Number.parseInt(process.env.SMOKE_TIMEOUT_MS || '20000', 10);

/* ------------------------------------------------------------------- utils */

const results = [];
let failed = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
  return ok;
}

function die(msg) {
  console.error(`\nsmoke test aborted: ${msg}`);
  process.exit(1);
}

/** Count leading zero bits of a hex id. Same algorithm as write-policy.mjs. */
function leadingZeroBits(hex) {
  let bits = 0;
  for (let i = 0; i < hex.length; i++) {
    const nibble = Number.parseInt(hex[i], 16);
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
 * NIP-13 mining with a committed target.
 *
 * The write policy requires BOTH a `["nonce", counter, target]` tag whose
 * target is at least the demanded difficulty AND an id that actually meets
 * that target. Committing up front is what stops an attacker from grinding
 * cheap events and publishing whichever one got lucky.
 *
 * In the real client this happens in a Web Worker behind the "spraying..."
 * spinner (copy deck: never mention mining).
 */
function mine(template, pubkey, bits) {
  const baseTags = (template.tags || []).filter((t) => t[0] !== 'nonce');
  const started = Date.now();
  let nonce = 0;

  for (;;) {
    const candidate = {
      ...template,
      pubkey,
      tags: [...baseTags, ['nonce', String(nonce), String(bits)]],
    };
    const id = getEventHash(candidate);
    if (leadingZeroBits(id) >= bits) {
      const ms = Date.now() - started;
      return { template: { ...template, tags: candidate.tags }, hashes: nonce + 1, ms };
    }
    nonce++;
    if (nonce % 200000 === 0) {
      process.stdout.write(`      ...mining ${bits} bits, ${nonce} hashes\n`);
    }
  }
}

function build(sk, pk, kind, content, bits, extraTags = []) {
  const template = {
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags: extraTags,
    content,
  };
  if (bits > 0) {
    const mined = mine(template, pk, bits);
    console.log(`      mined kind ${kind} to ${bits} bits in ${mined.ms}ms (${mined.hashes} hashes)`);
    return finalizeEvent(mined.template, sk);
  }
  return finalizeEvent(template, sk);
}

/* ------------------------------------------------------------ relay client */

class Relay {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.okWaiters = new Map(); // event id -> resolve
    this.subs = new Map(); // sub id -> { events, resolveEose }
    this.notices = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const t = setTimeout(() => reject(new Error(`connect timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);

      ws.on('open', () => {
        clearTimeout(t);
        this.ws = ws;
        resolve();
      });
      ws.on('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
      ws.on('message', (raw) => this.#onMessage(raw));
    });
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const [verb] = msg;

    if (verb === 'OK') {
      const [, id, accepted, message] = msg;
      const w = this.okWaiters.get(id);
      if (w) {
        this.okWaiters.delete(id);
        w({ accepted, message: message || '' });
      }
    } else if (verb === 'EVENT') {
      const [, subId, event] = msg;
      this.subs.get(subId)?.events.push(event);
    } else if (verb === 'EOSE') {
      const [, subId] = msg;
      const s = this.subs.get(subId);
      if (s) s.resolveEose();
    } else if (verb === 'NOTICE') {
      this.notices.push(msg[1]);
    } else if (verb === 'CLOSED') {
      const [, subId, reason] = msg;
      const s = this.subs.get(subId);
      if (s) {
        s.closedReason = reason;
        s.resolveEose();
      }
    }
  }

  #send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  publish(event) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.okWaiters.delete(event.id);
        reject(new Error(`no OK for ${event.id.slice(0, 12)} within ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      this.okWaiters.set(event.id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      this.#send(['EVENT', event]);
    });
  }

  async req(filter) {
    const subId = `smoke-${Math.random().toString(36).slice(2, 10)}`;
    let resolveEose;
    const eose = new Promise((r) => {
      resolveEose = r;
    });
    const state = { events: [], resolveEose, closedReason: null };
    this.subs.set(subId, state);
    this.#send(['REQ', subId, filter]);

    const timer = setTimeout(() => resolveEose(), TIMEOUT_MS);
    await eose;
    clearTimeout(timer);

    this.#send(['CLOSE', subId]);
    this.subs.delete(subId);
    return state;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* nothing to do */
    }
  }
}

/* ------------------------------------------------------------------- NIP-11 */

async function checkNip11(wsUrl) {
  const httpUrl = wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  try {
    const res = await fetch(httpUrl, { headers: { Accept: 'application/nostr+json' } });
    if (!res.ok) return check('NIP-11 relay info served', false, `HTTP ${res.status}`);
    const info = await res.json();
    return check(
      'NIP-11 relay info served',
      typeof info.name === 'string',
      `name="${info.name}" nips=${JSON.stringify(info.supported_nips ?? info.nips ?? [])}`,
    );
  } catch (e) {
    // Non-fatal: reaching the relay through Caddy's /relay path will not serve
    // NIP-11 at the same URL.
    return check('NIP-11 relay info served', false, `${e.message} (non-fatal when proxied via /relay)`);
  }
}

/* --------------------------------------------------------------------- main */

async function main() {
  console.log('1NKY relay smoke test');
  console.log(`  relay      ${RELAY_WS_URL}`);
  console.log(`  pow        ${POW_ENABLED ? `enabled (new=${POW_BITS_NEW} post=${POW_BITS_POST})` : 'DISABLED'}`);
  console.log('');

  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  console.log(`  throwaway pubkey ${pk.slice(0, 12)}…\n`);

  const relay = new Relay(RELAY_WS_URL);
  try {
    await relay.connect();
  } catch (e) {
    die(`could not connect to ${RELAY_WS_URL} — ${e.message}\n` +
        '  is the stack up?  docker compose up -d postgres strfry caddy');
  }
  check('websocket connected', true, RELAY_WS_URL);

  await checkNip11(RELAY_WS_URL);

  // --- 1. kind 0 profile ("pick a tag") at the NEW tier ----------------------
  const newBits = POW_ENABLED ? POW_BITS_NEW : 0;
  const profile = build(sk, pk, 0, JSON.stringify({ name: 'smoketest' }), newBits);
  const profileOk = await relay.publish(profile);
  check('kind 0 profile accepted', profileOk.accepted === true, profileOk.message || profile.id.slice(0, 12));

  // --- 2. kind 1 note at the POST tier ---------------------------------------
  const postBits = POW_ENABLED ? POW_BITS_POST : 0;
  const note = build(sk, pk, 1, 'phase 0 smoke test', postBits, [['t', 'smoketest']]);
  const noteOk = await relay.publish(note);
  check('kind 1 note accepted', noteOk.accepted === true, noteOk.message || note.id.slice(0, 12));

  // --- 3. read it back --------------------------------------------------------
  const byId = await relay.req({ ids: [note.id] });
  check(
    'REQ by id returns the note',
    byId.events.length === 1 && byId.events[0].id === note.id,
    `${byId.events.length} event(s)${byId.closedReason ? `, CLOSED: ${byId.closedReason}` : ''}`,
  );

  const byKind = await relay.req({ kinds: [1], '#t': ['smoketest'], limit: 10 });
  check('REQ by kind + t tag returns the note', byKind.events.some((e) => e.id === note.id), `${byKind.events.length} event(s)`);

  // --- 4. write policy: PoW gate ---------------------------------------------
  if (POW_ENABLED) {
    const unmined = build(sk, pk, 1, 'this one did not do the work', 0);
    const unminedOk = await relay.publish(unmined);
    check(
      'write policy rejects a note with no proof of work',
      unminedOk.accepted === false,
      unminedOk.message || '(no reason given)',
    );
  } else {
    console.log('  [SKIP] write policy PoW gate — POW_ENABLED=0');
  }

  // --- 5. write policy: kind allowlist ----------------------------------------
  // Mined to the POST tier so the ONLY reason it can be refused is the kind.
  const badKind = build(sk, pk, 9999, 'not an allowed kind', postBits);
  const badKindOk = await relay.publish(badKind);
  check(
    'write policy rejects a kind outside the allowlist',
    badKindOk.accepted === false,
    badKindOk.message || '(no reason given)',
  );

  relay.close();

  console.log('');
  if (failed > 0) {
    console.log(`${results.length - failed}/${results.length} checks passed — ${failed} FAILED`);
    console.log('\ntroubleshooting:');
    console.log('  docker compose logs strfry        # write-policy prints "kind=<n> accept|reject"');
    console.log('  docker compose ps                 # all three should be healthy');
    console.log('  POW_BITS_NEW / POW_BITS_POST here must match the strfry service env');
    process.exit(1);
  }
  console.log(`${results.length}/${results.length} checks passed — Phase 0 relay acceptance OK`);
  process.exit(0);
}

main().catch((e) => die(e?.stack || String(e)));
