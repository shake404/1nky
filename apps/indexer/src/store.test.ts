import { buildBuff, buildFlick, buildProfile, buildReport, KINDS } from '@1nky/protocol';
import { describe, expect, it } from 'vitest';

import {
  indexEvent,
  newCounters,
  readWatermark,
  sweepExpired,
  truncateDerived,
} from './store.js';
import { fakeDb, hex, makeEvent } from './testing/fixtures.js';

const AUTHOR = hex('ab');
const SHA = hex('cd');
const NOW = 1_700_000_000;

function flick(overrides: Parameters<typeof makeEvent>[0] = {}) {
  const template = buildFlick({
    url: 'https://cdn.example/a.webp',
    sha256: SHA,
    dims: { width: 100, height: 200 },
    boards: ['sf'],
    caption: 'wall',
    createdAt: NOW - 10,
  });
  return makeEvent({ ...template, id: hex('11'), pubkey: AUTHOR, ...overrides });
}

describe('indexEvent', () => {
  it('stores the raw event and bumps the author stats', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, flick(), counters, { now: NOW });

    expect(counters.events).toBe(1);
    expect(counters.flicks).toBe(1);
    expect(db.matching('insert into events')).toHaveLength(1);
    expect(db.matching('insert into pubkey_stats')).toHaveLength(1);
    expect(db.matching('insert into flicks')).toHaveLength(1);
    // The flick's board is auto-registered so GET /boards is never empty.
    expect(db.matching('insert into boards')).toHaveLength(1);
  });

  it('skips an already-expired event entirely (NIP-40)', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, flick({ tags: [['expiration', String(NOW - 1)]] }), counters, { now: NOW });

    expect(counters.expired).toBe(1);
    expect(counters.events).toBe(0);
    expect(db.calls).toHaveLength(0);
  });

  it('does no derived work for a duplicate event', async () => {
    const db = fakeDb((text) =>
      text.includes('insert into events') ? { rows: [], rowCount: 0 } : undefined,
    );
    const counters = newCounters();
    await indexEvent(db, flick(), counters, { now: NOW });

    expect(counters.duplicates).toBe(1);
    expect(counters.events).toBe(0);
    expect(db.matching('insert into flicks')).toHaveLength(0);
    expect(db.matching('insert into pubkey_stats')).toHaveLength(0);
  });

  it('stores a profile', async () => {
    const db = fakeDb();
    const counters = newCounters();
    const template = buildProfile({ tag: 'SMOG', city: 'sf' });
    await indexEvent(db, makeEvent({ ...template, kind: KINDS.PROFILE, pubkey: AUTHOR }), counters, {
      now: NOW,
    });

    expect(counters.profiles).toBe(1);
    expect(db.matching('insert into profiles')[0]?.params).toContain('SMOG');
  });

  it('counts a flick with no image as invalid but still keeps the event', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, makeEvent({ kind: KINDS.FLICK, tags: [] }), counters, { now: NOW });

    expect(counters.invalid).toBe(1);
    expect(counters.flicks).toBe(0);
    expect(db.matching('insert into events')).toHaveLength(1);
  });

  it('increments the reported writer report_count, not the reporter', async () => {
    const db = fakeDb();
    const counters = newCounters();
    const template = buildReport({ pubkey: AUTHOR, eventId: hex('11'), kind: 20 }, 'illegal');
    await indexEvent(db, makeEvent({ ...template, pubkey: hex('99') }), counters, { now: NOW });

    expect(counters.reports).toBe(1);
    const bump = db.matching('report_count   = pubkey_stats.report_count + 1');
    expect(bump).toHaveLength(1);
    expect(bump[0]?.params[0]).toBe(AUTHOR);
  });

  it('buffs: hard-deletes the signer own events named by a kind 5', async () => {
    const db = fakeDb((text) =>
      text.startsWith('delete from events') ? { rows: [], rowCount: 2 } : undefined,
    );
    const counters = newCounters();
    const template = buildBuff([hex('11'), hex('22')], { kinds: [20] });
    await indexEvent(db, makeEvent({ ...template, pubkey: AUTHOR }), counters, { now: NOW });

    expect(counters.deletions).toBe(1);
    expect(counters.buffed).toBe(2);

    const del = db.matching('delete from events')[0];
    expect(del?.params).toEqual([[hex('11'), hex('22')], AUTHOR]);
  });

  it('does not run a delete when every named target is malformed', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, makeEvent({ kind: KINDS.DELETE, tags: [['e', 'junk']] }), counters, {
      now: NOW,
    });

    expect(counters.deletions).toBe(1);
    expect(db.matching('delete from events')).toHaveLength(0);
  });

  it('only accepts the board registry from the site key when one is configured', async () => {
    const registry = makeEvent({
      kind: KINDS.APP_DATA,
      pubkey: AUTHOR,
      tags: [['d', 'boards']],
      content: JSON.stringify({ boards: [{ slug: 'sf', title: 'San Francisco' }] }),
    });

    const accepted = fakeDb();
    const acceptedCounters = newCounters();
    await indexEvent(accepted, registry, acceptedCounters, { now: NOW, sitePubkey: AUTHOR });
    expect(acceptedCounters.boards).toBe(1);

    const rejected = fakeDb();
    const rejectedCounters = newCounters();
    await indexEvent(rejected, registry, rejectedCounters, { now: NOW, sitePubkey: hex('ff') });
    expect(rejectedCounters.boards).toBe(0);
    expect(rejected.matching('insert into boards')).toHaveLength(0);
  });

  it('stores unrouted kinds in events only', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, makeEvent({ kind: KINDS.NOTE, content: 'thread op' }), counters, {
      now: NOW,
    });

    expect(counters.events).toBe(1);
    expect(db.calls.map((c) => c.text).filter((t) => t.includes('insert into'))).toHaveLength(2);
  });
});

describe('sweepExpired', () => {
  it('returns how many rows it removed', async () => {
    const db = fakeDb(() => ({ rows: [], rowCount: 7 }));
    await expect(sweepExpired(db, NOW)).resolves.toBe(7);
    expect(db.calls[0]?.params).toEqual([NOW]);
  });
});

describe('readWatermark', () => {
  it('parses the bigint pg hands back as a string', async () => {
    const db = fakeDb(() => ({ rows: [{ last_created_at: '1700000000' }], rowCount: 1 }));
    await expect(readWatermark(db)).resolves.toBe(1_700_000_000);
  });

  it('starts from zero on an empty index', async () => {
    const db = fakeDb(() => ({ rows: [], rowCount: 0 }));
    await expect(readWatermark(db)).resolves.toBe(0);
  });
});

describe('truncateDerived', () => {
  it('leaves the ban list alone', async () => {
    const db = fakeDb();
    await truncateDerived(db);
    expect(db.calls[0]?.text).not.toContain('banned_pubkeys');
  });
});
