import {
  buildBuff,
  buildComment,
  buildCrewBadgeRegistry,
  buildCrewDefinition,
  buildFlick,
  buildInvite,
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

  it('stores the date of a happening and registers its marker as its own kind', async () => {
    const db = fakeDb();
    const counters = newCounters();
    const template = buildThreadOp({
      subject: 'Yard jam',
      content: 'bring paint',
      boards: ['sf'],
      happeningAt: NOW + 86_400,
      createdAt: NOW - 20,
    });
    await indexEvent(db, makeEvent({ ...template, id: hex('5d'), pubkey: AUTHOR }), counters, {
      now: NOW,
    });

    // Same table, same route: a happening IS a thread.
    expect(counters.threads).toBe(1);
    expect(db.matching('insert into threads')[0]?.params[5]).toBe(NOW + 86_400);

    // Both slugs auto-register, but `happening` is not a city.
    const boards = db.matching('insert into boards').map((call) => [call.params[0], call.params[2]]);
    expect(boards).toEqual([
      ['sf', 'city'],
      ['happening', 'happening'],
    ]);
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

describe('mentions (kind 1111)', () => {
  const PARENT = { id: hex('11'), pubkey: hex('ef'), kind: KINDS.FLICK };
  const NAMED = hex('7a');

  function comment(options: Parameters<typeof buildComment>[1], id = hex('33')) {
    const template = buildComment(PARENT, { createdAt: NOW - 5, ...options });
    return makeEvent({ ...template, id, pubkey: AUTHOR });
  }

  it('files a row for a writer who was actually named', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, comment({ content: 'ask @named', mentions: [NAMED] }), counters, {
      now: NOW,
    });

    expect(counters.comments).toBe(1);
    expect(counters.mentions).toBe(1);
    const params = db.matching('insert into mentions')[0]?.params;
    expect(params?.[0]).toBe(hex('33'));
    expect(params?.[1]).toBe(NAMED);
    expect(params?.[2]).toBe(AUTHOR);
    // The deep link target: the thread this hangs off.
    expect(params?.[3]).toBe(PARENT.id);
  });

  it('files nothing for a plain reply', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, comment({ content: 'clean' }), counters, { now: NOW });

    // The parent author gets a `p` tag from NIP-22 alone. A reply is not a
    // mention, or the inbox would just be the reply feed again.
    expect(counters.comments).toBe(1);
    expect(counters.mentions).toBe(0);
    expect(db.matching('insert into mentions')).toHaveLength(0);
  });

  it('files nothing for a comment it refuses to store', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(
      db,
      makeEvent({
        kind: KINDS.COMMENT,
        id: hex('34'),
        pubkey: AUTHOR,
        tags: [['p', NAMED, '', 'mention']],
      }),
      counters,
      { now: NOW },
    );

    // Anchored to nothing: no comment row, so no mention hanging off one.
    expect(counters.invalid).toBe(1);
    expect(db.matching('insert into mentions')).toHaveLength(0);
  });
});

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

// ---------------------------------------------------------------------------
// Invites — "getting put on"
// ---------------------------------------------------------------------------

const INVITER = hex('1a');
const CHILD = hex('2b');
const INVITE_ID = 'ab12cd34ef567890';

function inviteMint(overrides: Parameters<typeof makeEvent>[0] = {}) {
  const template = buildInvite(INVITE_ID, { createdAt: NOW });
  return makeEvent({ ...template, pubkey: INVITER, id: hex('55'), ...overrides });
}

function redemption(overrides: Parameters<typeof makeEvent>[0] = {}) {
  const template = buildProfile({
    tag: 'NEWJACK',
    invite: { inviteId: INVITE_ID, inviterPubkey: INVITER },
    createdAt: NOW + 10,
  });
  return makeEvent({ ...template, pubkey: CHILD, id: hex('66'), ...overrides });
}

describe('invite mints (kind 30078, d:invite:<id>)', () => {
  it('records the invite, keyed by id and attributed to the signer', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, inviteMint(), counters, { now: NOW });

    expect(counters.invites).toBe(1);
    const insert = db.matching('insert into invites')[0];
    expect(insert?.params).toEqual([INVITE_ID, INVITER, NOW]);
    // First mint wins, and a banned pubkey mints nothing — both in SQL.
    expect(insert?.text).toContain('on conflict (invite_id) do nothing');
    expect(insert?.text).toContain('from banned_pubkeys');
  });

  it('needs no moderator or site key — anybody here may put somebody on', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, inviteMint({ pubkey: hex('99') }), counters, {
      now: NOW,
      sitePubkey: hex('7f'),
      modPubkeys: MODS,
    });

    expect(counters.invites).toBe(1);
    expect(db.matching('insert into invites')[0]?.params?.[1]).toBe(hex('99'));
  });

  it('does not count a mint the database refused (banned inviter, or id taken)', async () => {
    const db = fakeDb((text) =>
      text.includes('insert into invites') ? { rows: [], rowCount: 0 } : undefined,
    );
    const counters = newCounters();
    await indexEvent(db, inviteMint(), counters, { now: NOW });

    expect(counters.invites).toBe(0);
    // The raw event is still kept: the relay accepted it, and inert app data is
    // not an error.
    expect(db.matching('insert into events')).toHaveLength(1);
  });

  it('is not confused with a crew definition, a badge registry or a board list', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, inviteMint(), counters, { now: NOW, sitePubkey: INVITER });

    expect(db.matching('insert into crews')).toHaveLength(0);
    expect(db.matching('insert into crew_badges')).toHaveLength(0);
    expect(db.matching('insert into boards')).toHaveLength(0);
  });

  it('leaves invites alone when a mod ban rides on the same kind', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, modBan('ban'), counters, { now: NOW, modPubkeys: MODS });

    expect(db.matching('insert into invites')).toHaveLength(0);
    expect(counters.invites).toBe(0);
  });
});

describe('invite redemptions (an `invite` tag on a kind 0)', () => {
  it('marks the invite redeemed and records the edge', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, redemption(), counters, { now: NOW + 10 });

    expect(counters.profiles).toBe(1);
    expect(counters.putOn).toBe(1);

    const update = db.matching('update invites')[0];
    expect(update?.params).toEqual([INVITE_ID, INVITER, CHILD, NOW + 10]);
    // Every rule is a predicate on the one statement, not a read-then-write.
    expect(update?.text).toContain('inviter = $2');
    expect(update?.text).toContain('inviter <> $3');
    expect(update?.text).toContain('redeemed_by is null or redeemed_by = $3');
    expect(update?.text).toContain('from banned_pubkeys');
    expect(update?.text).toContain('from invite_edges e where e.child = $3');

    const edge = db.matching('insert into invite_edges')[0];
    expect(edge?.params).toEqual([CHILD, INVITER, INVITE_ID, NOW + 10]);
    expect(edge?.text).toContain('on conflict (child) do nothing');
  });

  it('still indexes an ordinary profile that redeems nothing', async () => {
    const db = fakeDb();
    const counters = newCounters();
    const template = buildProfile({ tag: 'SMOG', createdAt: NOW });
    await indexEvent(db, makeEvent({ ...template, pubkey: AUTHOR }), counters, { now: NOW });

    expect(counters.profiles).toBe(1);
    expect(counters.putOn).toBe(0);
    expect(db.matching('update invites')).toHaveLength(0);
    expect(db.matching('invite_edges')).toHaveLength(0);
  });

  it('ignores a redemption the database refused, silently, and keeps the profile', async () => {
    // rowCount 0 is what the UPDATE returns for a self-invite, a banned inviter,
    // a forged inviter, an unknown invite, one already redeemed by somebody else,
    // or a child who already has a parent. The indexer cannot tell them apart and
    // deliberately does not try: naming which rule failed would mean logging
    // pubkeys.
    const db = fakeDb((text) =>
      text.includes('update invites') ? { rows: [], rowCount: 0 } : undefined,
    );
    const counters = newCounters();
    let exported = 0;

    await indexEvent(db, redemption(), counters, {
      now: NOW + 10,
      onInvitedChange: async () => {
        exported += 1;
      },
    });

    expect(counters.profiles).toBe(1);
    expect(counters.putOn).toBe(0);
    expect(db.matching('insert into invite_edges')).toHaveLength(0);
    expect(exported).toBe(0);
  });

  it('is idempotent on a replay: the edge conflicts, so nothing is counted twice', async () => {
    // A replayed kind 0 passes `redeemed_by = $3` (this same writer) but the edge
    // already exists, so `do nothing` returns 0 rows.
    const db = fakeDb((text) =>
      text.includes('insert into invite_edges') ? { rows: [], rowCount: 0 } : undefined,
    );
    const counters = newCounters();
    let exported = 0;

    await indexEvent(db, redemption(), counters, {
      now: NOW + 10,
      onInvitedChange: async () => {
        exported += 1;
      },
    });

    expect(counters.putOn).toBe(0);
    expect(exported).toBe(0);
  });

  it('never lets a self-invite through — the rule is in the statement', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, redemption({ pubkey: INVITER }), counters, { now: NOW + 10 });

    const update = db.matching('update invites')[0];
    // Same pubkey in both positions, and the predicate refuses it in Postgres.
    expect(update?.params?.[1]).toBe(INVITER);
    expect(update?.params?.[2]).toBe(INVITER);
    expect(update?.text).toContain('inviter <> $3');
  });

  it('re-exports the relay invited list after a new edge', async () => {
    const db = fakeDb();
    const counters = newCounters();
    let exported = 0;

    await indexEvent(db, redemption(), counters, {
      now: NOW + 10,
      onInvitedChange: async () => {
        exported += 1;
      },
    });

    expect(exported).toBe(1);
  });
});

describe('subtree bans', () => {
  it('expands a subtree ban to every descendant, as one action', async () => {
    const db = fakeDb();
    const counters = newCounters();
    const template = buildModBan(TARGET, 'ban', {
      reason: 'tag farm',
      subtree: true,
      createdAt: NOW,
    });
    let exported = 0;

    await indexEvent(db, makeEvent({ ...template, pubkey: MOD, id: hex('44') }), counters, {
      now: NOW,
      modPubkeys: MODS,
      onBanChange: async () => {
        exported += 1;
      },
    });

    expect(counters.bans).toBe(1);
    const cascade = db.matching('with recursive descendants')[0];
    expect(cascade?.text).toContain('from invite_edges');
    // Same moderator, same instant, same reason as the ban that asked for it.
    expect(cascade?.params).toEqual([TARGET, 'tag farm', NOW, MOD]);
    // `union`, not `union all`: dedup is what terminates a cycle.
    expect(cascade?.text).toContain('union\n');
    expect(cascade?.text).not.toContain('union all');
    // A descendant carrying a NEWER ban of their own keeps it.
    expect(cascade?.text).toContain('excluded.banned_at >= banned_pubkeys.banned_at');
    // ONE export, after the whole expansion — never one per descendant.
    expect(exported).toBe(1);
  });

  it('reads the reason prefix too, for tooling with only a reason field', async () => {
    const db = fakeDb();
    const counters = newCounters();
    const template = buildModBan(TARGET, 'ban', { reason: 'subtree: tag farm', createdAt: NOW });
    await indexEvent(db, makeEvent({ ...template, pubkey: MOD, id: hex('44') }), counters, {
      now: NOW,
      modPubkeys: MODS,
    });

    expect(db.matching('with recursive descendants')).toHaveLength(1);
  });

  it('does not expand an ordinary ban', async () => {
    const db = fakeDb();
    const counters = newCounters();
    await indexEvent(db, modBan('ban', {}, 'illegal'), counters, { now: NOW, modPubkeys: MODS });

    expect(db.matching('with recursive descendants')).toHaveLength(0);
    expect(counters.subtreeBans).toBe(0);
  });

  it('never cascades an unban, however it is spelled', async () => {
    const db = fakeDb();
    const counters = newCounters();
    const template = buildModBan(TARGET, 'unban', {
      reason: 'subtree: sorry',
      subtree: true,
      createdAt: NOW,
    });
    await indexEvent(db, makeEvent({ ...template, pubkey: MOD, id: hex('44') }), counters, {
      now: NOW,
      modPubkeys: MODS,
    });

    expect(counters.unbans).toBe(1);
    expect(db.matching('with recursive descendants')).toHaveLength(0);
  });

  it('expands nothing when the signer is not a moderator', async () => {
    const db = fakeDb();
    const counters = newCounters();
    const template = buildModBan(TARGET, 'ban', { subtree: true, createdAt: NOW });
    await indexEvent(db, makeEvent({ ...template, pubkey: hex('99'), id: hex('44') }), counters, {
      now: NOW,
      modPubkeys: MODS,
    });

    expect(db.matching('banned_pubkeys')).toHaveLength(0);
    expect(db.matching('with recursive descendants')).toHaveLength(0);
  });

  it('counts the descendants it actually banned', async () => {
    const db = fakeDb((text) =>
      text.includes('with recursive descendants') ? { rows: [], rowCount: 3 } : undefined,
    );
    const counters = newCounters();
    const template = buildModBan(TARGET, 'ban', { subtree: true, createdAt: NOW });
    await indexEvent(db, makeEvent({ ...template, pubkey: MOD, id: hex('44') }), counters, {
      now: NOW,
      modPubkeys: MODS,
    });

    expect(counters.subtreeBans).toBe(3);
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
