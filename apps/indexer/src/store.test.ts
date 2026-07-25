import {
  buildBuff,
  buildCrewBadgeRegistry,
  buildCrewDefinition,
  buildFlick,
  buildProfile,
  buildReport,
  buildVideo,
  KINDS,
} from '@1nky/protocol';
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

function video(overrides: Parameters<typeof makeEvent>[0] = {}) {
  const template = buildVideo({
    url: 'https://cdn.example/v.mp4',
    sha256: SHA,
    dims: { width: 1280, height: 720 },
    durationSec: 12,
    poster: 'https://cdn.example/p.webp',
    boards: ['sf'],
    caption: 'roll-up',
    createdAt: NOW - 5,
  });
  return makeEvent({ ...template, id: hex('22'), pubkey: AUTHOR, ...overrides });
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
    const template = buildProfile({ tag: 'SMOG', city: 'sf', bio: 'panels only' });
    await indexEvent(db, makeEvent({ ...template, kind: KINDS.PROFILE, pubkey: AUTHOR }), counters, {
      now: NOW,
    });

    expect(counters.profiles).toBe(1);
    const params = db.matching('insert into profiles')[0]?.params;
    expect(params).toContain('SMOG');
    expect(params).toContain('panels only');
  });

  it('counts a flick with no image as invalid but still keeps the event', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, makeEvent({ kind: KINDS.FLICK, tags: [] }), counters, { now: NOW });

    expect(counters.invalid).toBe(1);
    expect(counters.flicks).toBe(0);
    expect(db.matching('insert into events')).toHaveLength(1);
  });

  it('stores a video (kind 22) and discovers its boards', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, video(), counters, { now: NOW });

    expect(counters.videos).toBe(1);
    expect(db.matching('insert into videos')).toHaveLength(1);
    const params = db.matching('insert into videos')[0]?.params;
    expect(params).toContain('https://cdn.example/v.mp4');
    expect(params).toContain('https://cdn.example/p.webp');
    // Boards are auto-registered just like flicks.
    expect(db.matching('insert into boards')).toHaveLength(1);
  });

  it('counts a video with no url or blob hash as invalid but keeps the event', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, makeEvent({ kind: KINDS.VIDEO, tags: [] }), counters, { now: NOW });

    expect(counters.invalid).toBe(1);
    expect(counters.videos).toBe(0);
    expect(db.matching('insert into events')).toHaveLength(1);
    expect(db.matching('insert into videos')).toHaveLength(0);
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

  it('indexes a crew definition (d:crew) signed by the crew own key', async () => {
    const def = makeEvent({
      ...buildCrewDefinition({ name: 'FASE', members: [hex('01'), hex('02')] }),
      kind: KINDS.APP_DATA,
      pubkey: AUTHOR,
      id: hex('33'),
    });
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, def, counters, { now: NOW });

    expect(counters.crews).toBe(1);
    const upsert = db.matching('insert into crews')[0];
    expect(upsert).toBeDefined();
    expect(upsert?.params[0]).toBe(AUTHOR);
    expect(upsert?.params[1]).toBe('FASE');
    expect(upsert?.params[5]).toEqual([hex('01'), hex('02')]);
  });

  it('counts a crew definition with no name as nothing derived', async () => {
    const def = makeEvent({
      kind: KINDS.APP_DATA,
      pubkey: AUTHOR,
      tags: [['d', 'crew']],
      content: '{"name":""}',
    });
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, def, counters, { now: NOW });

    expect(counters.crews).toBe(0);
    expect(db.matching('insert into crews')).toHaveLength(0);
    // The raw event is still kept.
    expect(db.matching('insert into events')).toHaveLength(1);
  });

  it('only indexes crew badges (d:crew-badges) from the site key', async () => {
    const template = buildCrewBadgeRegistry({ crewPubkeys: [hex('01'), hex('02')] });
    const badge = (pubkey: string) =>
      makeEvent({ ...template, kind: KINDS.APP_DATA, pubkey, id: hex(pubkey.slice(0, 1)) });

    const accepted = fakeDb();
    const acceptedCounters = newCounters();
    await indexEvent(accepted, badge(AUTHOR), acceptedCounters, { now: NOW, sitePubkey: AUTHOR });
    expect(acceptedCounters.crewBadges).toBe(2);
    expect(accepted.matching('insert into crew_badges')).toHaveLength(2);

    const rejected = fakeDb();
    const rejectedCounters = newCounters();
    await indexEvent(rejected, badge(hex('99')), rejectedCounters, { now: NOW, sitePubkey: AUTHOR });
    expect(rejectedCounters.crewBadges).toBe(0);
    expect(rejected.matching('insert into crew_badges')).toHaveLength(0);
  });

  it('writes ZERO rows for a gift wrap (kind 1059)', async () => {
    // Private messages must not exist in an index that is served through a
    // public read API. Not the ciphertext, not the recipient tag, not the
    // timestamp — the metadata alone reconstructs the social graph.
    const db = fakeDb();
    const counters = newCounters();
    const recipient = hex('ee');

    await indexEvent(
      db,
      makeEvent({
        kind: KINDS.GIFT_WRAP,
        id: hex('77'),
        pubkey: hex('12'),
        tags: [['p', recipient]],
        content: 'AsK0KGvfrmHy...base64 nip44 payload',
      }),
      counters,
      { now: NOW },
    );

    // Not one statement was issued — not even the `events` insert or the
    // pubkey_stats touch.
    expect(db.calls).toEqual([]);
    expect(counters.skipped).toBe(1);
    expect(counters.events).toBe(0);

    // And nothing about the message ended up anywhere we could have logged it.
    const everything = JSON.stringify(db.calls);
    expect(everything).not.toContain(recipient);
    expect(everything).not.toContain('base64');
  });

  it('skips a gift wrap even when it is squeezed in among real events', async () => {
    const db = fakeDb();
    const counters = newCounters();

    await indexEvent(db, flick(), counters, { now: NOW });
    await indexEvent(db, makeEvent({ kind: KINDS.GIFT_WRAP, id: hex('78') }), counters, {
      now: NOW,
    });
    await indexEvent(db, makeEvent({ kind: KINDS.NOTE, id: hex('79') }), counters, { now: NOW });

    expect(counters.events).toBe(2);
    expect(counters.skipped).toBe(1);
    for (const call of db.calls) expect(call.params).not.toContain(KINDS.GIFT_WRAP);
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
