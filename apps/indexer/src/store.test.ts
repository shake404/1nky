import {
  buildBuff,
  buildCrewBadgeRegistry,
  buildCrewDefinition,
  buildFlick,
  buildModBan,
  buildProfile,
  buildReport,
  buildThreadOp,
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
    await indexEvent(db, makeEvent({ kind: KINDS.MUTE_LIST, content: '[]' }), counters, {
      now: NOW,
    });

    expect(counters.events).toBe(1);
    expect(db.calls.map((c) => c.text).filter((t) => t.includes('insert into'))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Thread OPs — kind 1 with a `subject` tag and board `t` tags
// ---------------------------------------------------------------------------

describe('thread OPs (kind 1)', () => {
  function threadOp(overrides: Parameters<typeof makeEvent>[0] = {}) {
    const template = buildThreadOp({
      subject: 'Who buffed the Alameda wall?',
      boards: ['sf'],
      content: 'gone as of this morning',
      createdAt: NOW - 20,
    });
    return makeEvent({ ...template, id: hex('55'), pubkey: AUTHOR, ...overrides });
  }

  it('routes a thread OP to the threads table and bumps the author stats', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, threadOp(), counters, { now: NOW });

    expect(counters.threads).toBe(1);
    expect(counters.events).toBe(1);
    expect(db.matching('insert into threads')).toHaveLength(1);
    expect(db.matching('insert into pubkey_stats')).toHaveLength(1);

    const params = db.matching('insert into threads')[0]?.params;
    expect(params?.[0]).toBe(hex('55'));
    expect(params?.[2]).toBe('Who buffed the Alameda wall?');
    expect(params?.[3]).toEqual(['sf']);
  });

  it('auto-registers the boards a thread was posted to', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, threadOp(), counters, { now: NOW });

    // A board with only threads on it still shows up in GET /boards.
    expect(db.matching('insert into boards')).toHaveLength(1);
    expect(db.matching('insert into boards')[0]?.params[0]).toBe('sf');
  });

  it('indexes a bare kind 1 with no subject and no board — never "invalid"', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, makeEvent({ kind: KINDS.NOTE, id: hex('56'), content: 'oi' }), counters, {
      now: NOW,
    });

    expect(counters.threads).toBe(1);
    expect(counters.invalid).toBe(0);
    expect(db.matching('insert into threads')).toHaveLength(1);
    expect(db.matching('insert into threads')[0]?.params[2]).toBeNull();
    // No board tags means no board rows.
    expect(db.matching('insert into boards')).toHaveLength(0);
  });

  it('skips an already-expired beef entirely (NIP-40)', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, threadOp({ tags: [['expiration', String(NOW - 1)]] }), counters, {
      now: NOW,
    });

    expect(counters.threads).toBe(0);
    expect(db.calls).toHaveLength(0);
  });

  it('does no derived work for a re-delivered thread OP', async () => {
    const db = fakeDb((text) =>
      text.includes('insert into events') ? { rows: [], rowCount: 0 } : undefined,
    );
    const counters = newCounters();
    await indexEvent(db, threadOp(), counters, { now: NOW });

    expect(counters.duplicates).toBe(1);
    expect(counters.threads).toBe(0);
    expect(db.matching('insert into threads')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Moderator bans — kind 30078, d = "ban:<target>"
// ---------------------------------------------------------------------------

const MOD = hex('7f');
const TARGET = hex('be');
const MODS: ReadonlySet<string> = new Set([MOD]);

function modBan(
  action: 'ban' | 'unban',
  overrides: Parameters<typeof makeEvent>[0] = {},
  reason?: string,
) {
  const template = buildModBan(TARGET, action, {
    createdAt: NOW,
    ...(reason === undefined ? {} : { reason }),
  });
  return makeEvent({ ...template, kind: KINDS.APP_DATA, pubkey: MOD, id: hex('44'), ...overrides });
}

describe('moderator bans (kind 30078, d:ban:<pubkey>)', () => {
  it('applies a ban signed by a moderator', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, modBan('ban', {}, 'illegal'), counters, { now: NOW, modPubkeys: MODS });

    expect(counters.bans).toBe(1);
    const upsert = db.matching('insert into banned_pubkeys')[0];
    expect(upsert?.params).toEqual([TARGET, 'illegal', NOW, MOD]);
  });

  it('ignores a ban from a pubkey that is not a moderator', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, modBan('ban', { pubkey: hex('99') }), counters, {
      now: NOW,
      modPubkeys: MODS,
    });

    expect(counters.bans).toBe(0);
    expect(db.matching('banned_pubkeys')).toHaveLength(0);
    // Inert app data, not an error: the raw event is still kept.
    expect(db.matching('insert into events')).toHaveLength(1);
  });

  it('ignores every ban when no moderators are configured', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, modBan('ban'), counters, { now: NOW });

    expect(counters.bans).toBe(0);
    expect(db.matching('banned_pubkeys')).toHaveLength(0);
  });

  it('matches the moderator pubkey case-insensitively', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, modBan('ban', { pubkey: MOD.toUpperCase() }), counters, {
      now: NOW,
      modPubkeys: MODS,
    });

    expect(counters.bans).toBe(1);
  });

  it('lifts a ban on unban, scoped so a stale unban cannot regress it', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, modBan('unban', { created_at: NOW + 10 }), counters, {
      now: NOW + 10,
      modPubkeys: MODS,
    });

    expect(counters.unbans).toBe(1);
    const del = db.matching('delete from banned_pubkeys')[0];
    // The delete carries the action's own timestamp, so Postgres — not the
    // indexer — refuses an unban older than the ban in force.
    expect(del?.text).toContain('banned_at <= $2');
    expect(del?.params).toEqual([TARGET, NOW + 10]);
  });

  it('does not count or export a stale unban the database refused', async () => {
    // rowCount 0 is exactly what `delete ... and banned_at <= $2` returns when
    // the ban in force is newer than this unban.
    const db = fakeDb((text) =>
      text.includes('delete from banned_pubkeys') ? { rows: [], rowCount: 0 } : undefined,
    );
    const counters = newCounters();
    const exports: number[] = [];

    await indexEvent(db, modBan('unban', { created_at: NOW - 100 }), counters, {
      now: NOW,
      modPubkeys: MODS,
      onBanChange: async () => {
        exports.push(1);
      },
    });

    expect(counters.unbans).toBe(0);
    expect(exports).toEqual([]);
  });

  it('does not count or export a stale ban the database refused', async () => {
    const db = fakeDb((text) =>
      text.includes('insert into banned_pubkeys') ? { rows: [], rowCount: 0 } : undefined,
    );
    const counters = newCounters();
    const exports: number[] = [];

    await indexEvent(db, modBan('ban', { created_at: NOW - 100 }), counters, {
      now: NOW,
      modPubkeys: MODS,
      onBanChange: async () => {
        exports.push(1);
      },
    });

    expect(counters.bans).toBe(0);
    expect(exports).toEqual([]);
  });

  it('re-exports the relay ban list after an applied change', async () => {
    const db = fakeDb();
    const counters = newCounters();
    let exported = 0;

    await indexEvent(db, modBan('ban'), counters, {
      now: NOW,
      modPubkeys: MODS,
      onBanChange: async () => {
        exported += 1;
      },
    });

    expect(exported).toBe(1);
  });

  it('leaves crew definitions alone — a ban is not a registry entry', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, modBan('ban'), counters, { now: NOW, modPubkeys: MODS });

    expect(db.matching('insert into crews')).toHaveLength(0);
    expect(db.matching('insert into boards')).toHaveLength(0);
    expect(counters.crews).toBe(0);
  });
});

describe('moderator takedowns (kind 5)', () => {
  it('lets a moderator buff another writer event', async () => {
    const db = fakeDb((text) =>
      text.startsWith('delete from events') ? { rows: [], rowCount: 1 } : undefined,
    );
    const counters = newCounters();
    const template = buildBuff([hex('11')], { kinds: [20] });
    await indexEvent(db, makeEvent({ ...template, pubkey: MOD }), counters, {
      now: NOW,
      modPubkeys: MODS,
    });

    expect(counters.buffed).toBe(1);
    const del = db.matching('delete from events')[0];
    // No ownership predicate: the takedown reaches whoever authored it.
    expect(del?.text).not.toContain('pubkey = $2');
    expect(del?.params).toEqual([[hex('11')]]);
  });

  it('still scopes a non-moderator kind 5 to the signer own events', async () => {
    const db = fakeDb((text) =>
      text.startsWith('delete from events') ? { rows: [], rowCount: 0 } : undefined,
    );
    const counters = newCounters();
    const template = buildBuff([hex('11')], { kinds: [20] });
    await indexEvent(db, makeEvent({ ...template, pubkey: AUTHOR }), counters, {
      now: NOW,
      modPubkeys: MODS,
    });

    const del = db.matching('delete from events')[0];
    expect(del?.text).toContain('and pubkey = $2');
    expect(del?.params).toEqual([[hex('11')], AUTHOR]);
  });

  it('grants nobody takedown power when no moderators are configured', async () => {
    const db = fakeDb();
    const counters = newCounters();
    const template = buildBuff([hex('11')], {});
    await indexEvent(db, makeEvent({ ...template, pubkey: MOD }), counters, { now: NOW });

    expect(db.matching('delete from events')[0]?.text).toContain('and pubkey = $2');
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
