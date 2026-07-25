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
  CREW_BADGES_DTAG,
  CREW_DEFINITION_DTAG,
  KINDS,
} from '@1nky/protocol';
import { describe, expect, it } from 'vitest';

import {
  boardKindOf,
  boardRowsFromFlick,
  boardRowsFromRegistry,
  boardsOf,
  crewBadgeRowsFromRegistry,
  crewDefinitionRowFromEvent,
  expirationOf,
  inviteRedemptionFromEvent,
  inviteRowFromEvent,
  isExpired,
  modBanActionFromEvent,
  parseImeta,
  routeOf,
  tagValue,
  tagValues,
  toCommentRow,
  toDeletionRow,
  toEventRow,
  toFlickRow,
  toProfileRow,
  toReportRow,
  toThreadRow,
  toVideoRow,
} from './mappers.js';
import { hex, makeEvent } from './testing/fixtures.js';

const AUTHOR = hex('ab');
const SHA = hex('cd');

describe('tag helpers', () => {
  const tags = [
    ['t', 'sf'],
    ['t', 'oakland'],
    ['t', ''],
    ['e', 'abc'],
  ];

  it('reads the first value of a named tag', () => {
    expect(tagValue(tags, 't')).toBe('sf');
    expect(tagValue(tags, 'nope')).toBeUndefined();
  });

  it('skips empty tag values', () => {
    expect(tagValues(tags, 't')).toEqual(['sf', 'oakland']);
  });

  it('normalises and dedupes board slugs', () => {
    const event = makeEvent({
      tags: [
        ['t', 'SF Bay'],
        ['t', '#sf-bay'],
        ['t', 'Oakland'],
      ],
    });
    expect(boardsOf(event)).toEqual(['sf-bay', 'oakland']);
  });
});

describe('NIP-40 expiration', () => {
  it('reads the expiration tag', () => {
    expect(expirationOf(makeEvent({ tags: [['expiration', '1700000123']] }))).toBe(1_700_000_123);
  });

  it('treats a missing or junk tag as permanent', () => {
    expect(expirationOf(makeEvent())).toBeNull();
    expect(expirationOf(makeEvent({ tags: [['expiration', 'soon']] }))).toBeNull();
    expect(expirationOf(makeEvent({ tags: [['expiration', '-5']] }))).toBeNull();
  });

  it('is expired at or after the deadline, not before', () => {
    const event = makeEvent({ tags: [['expiration', '1000']] });
    expect(isExpired(event, 999)).toBe(false);
    expect(isExpired(event, 1000)).toBe(true);
    expect(isExpired(event, 1001)).toBe(true);
    expect(isExpired(makeEvent(), 1e12)).toBe(false);
  });
});

describe('toEventRow', () => {
  it('serialises tags and the raw event as JSON', () => {
    const event = makeEvent({ kind: 20, content: 'burner', tags: [['t', 'sf']] });
    const row = toEventRow(event);
    expect(row.kind).toBe(20);
    expect(JSON.parse(row.tags)).toEqual([['t', 'sf']]);
    expect(JSON.parse(row.raw)).toMatchObject({ id: event.id, sig: event.sig });
    expect(row.expires_at).toBeNull();
  });

  it('carries the expiry through', () => {
    const row = toEventRow(makeEvent({ tags: [['expiration', '4102444800']] }));
    expect(row.expires_at).toBe(4_102_444_800);
  });
});

describe('toProfileRow (kind 0)', () => {
  it('maps a profile built by @1nky/protocol', () => {
    const template = buildProfile({
      tag: 'SMOG',
      city: 'SF Bay',
      bio: 'panels and rooftops',
      avatarSha256: SHA,
      crews: [hex('01'), hex('02')],
    });
    const row = toProfileRow(makeEvent({ ...template, pubkey: AUTHOR, kind: KINDS.PROFILE }));

    expect(row).toMatchObject({
      pubkey: AUTHOR,
      tag_name: 'SMOG',
      city: 'sf-bay',
      about: 'panels and rooftops',
      avatar_sha256: SHA,
      crews: [hex('01'), hex('02')],
    });
    expect(row.first_seen).toBe(row.updated_at);
  });

  it('parses self-declared crews from kind-0 content, deduped and lowercased', () => {
    const row = toProfileRow(
      makeEvent({ kind: 0, content: JSON.stringify({ name: 'X', crews: ['AB'.repeat(32), '  ' + 'CD'.repeat(32) + '  ', 'AB'.repeat(32), 9] }) }),
    );
    expect(row.crews).toEqual(['ab'.repeat(32), 'cd'.repeat(32)]);
  });

  it('leaves crews empty when the writer declares none', () => {
    const template = buildProfile({ tag: 'SMOG' });
    expect(toProfileRow(makeEvent({ ...template, kind: KINDS.PROFILE })).crews).toEqual([]);
    expect(toProfileRow(makeEvent({ kind: 0, content: '{"name":"X"}' })).crews).toEqual([]);
    expect(toProfileRow(makeEvent({ kind: 0, content: '{"name":"X","crews":"not-an-array"}' })).crews).toEqual([]);
  });

  it('leaves `about` null when the writer has no bio', () => {
    const template = buildProfile({ tag: 'SMOG' });
    expect(toProfileRow(makeEvent({ ...template, kind: KINDS.PROFILE })).about).toBeNull();
    expect(toProfileRow(makeEvent({ kind: 0, content: '{"about":"   "}' })).about).toBeNull();
    expect(toProfileRow(makeEvent({ kind: 0, content: '{"about":42}' })).about).toBeNull();
  });

  it('reads an `about` written by any other Nostr client', () => {
    // The field name is the ecosystem's, not ours — a profile made elsewhere
    // has to land in the same column.
    const row = toProfileRow(
      makeEvent({ kind: 0, content: JSON.stringify({ name: 'SMOG', about: ' from elsewhere ' }) }),
    );
    expect(row.about).toBe('from elsewhere');
  });

  it('truncates a hostile 60KB bio', () => {
    const row = toProfileRow(
      makeEvent({ kind: 0, content: JSON.stringify({ about: 'y'.repeat(60_000) }) }),
    );
    expect(row.about).toHaveLength(500);
  });

  it('survives unparseable content', () => {
    const row = toProfileRow(makeEvent({ kind: 0, content: 'not json' }));
    expect(row.tag_name).toBeNull();
    expect(row.city).toBeNull();
    expect(row.about).toBeNull();
  });

  it('survives content that is a JSON array', () => {
    expect(toProfileRow(makeEvent({ kind: 0, content: '[1,2]' })).tag_name).toBeNull();
  });
});

describe('toFlickRow (kind 20)', () => {
  const template = buildFlick({
    url: 'https://cdn.example/1.webp',
    sha256: SHA,
    dims: { width: 1024, height: 768 },
    blurhash: 'LEHV6n',
    caption: 'rooftop',
    boards: ['SF Bay', 'sf-bay', 'Oakland'],
  });

  it('maps imeta into columns', () => {
    const row = toFlickRow(makeEvent({ ...template, pubkey: AUTHOR, id: hex('11') }));
    expect(row).toEqual({
      event_id: hex('11'),
      pubkey: AUTHOR,
      created_at: template.created_at,
      url: 'https://cdn.example/1.webp',
      sha256: SHA,
      width: 1024,
      height: 768,
      blurhash: 'LEHV6n',
      caption: 'rooftop',
      boards: ['sf-bay', 'oakland'],
    });
  });

  it('falls back to top-level tags when imeta is absent', () => {
    const row = toFlickRow(
      makeEvent({
        kind: 20,
        tags: [
          ['url', 'https://cdn.example/2.webp'],
          ['x', SHA],
        ],
      }),
    );
    expect(row?.url).toBe('https://cdn.example/2.webp');
    expect(row?.sha256).toBe(SHA);
    expect(row?.width).toBeNull();
  });

  it('rejects a flick with no image', () => {
    expect(toFlickRow(makeEvent({ kind: 20, tags: [['t', 'sf']] }))).toBeNull();
  });

  it('parses malformed dim strings as unknown dimensions', () => {
    expect(parseImeta(['imeta', 'url u', 'x y', 'dim wide']).width).toBeNull();
    expect(parseImeta(undefined)).toEqual({
      url: null,
      sha256: null,
      width: null,
      height: null,
      blurhash: null,
      poster: null,
      duration: null,
    });
  });

  it('reads the video poster still and duration out of imeta', () => {
    const fields = parseImeta([
      'imeta',
      'url https://m.example/v.mp4',
      'x ' + SHA,
      'dim 1280x720',
      'image https://m.example/p.webp',
      'duration 42',
    ]);
    expect(fields.poster).toBe('https://m.example/p.webp');
    expect(fields.duration).toBe(42);
    expect(parseImeta(['imeta', 'duration soon']).duration).toBeNull();
  });
});

describe('toVideoRow (kind 22)', () => {
  const template = buildVideo({
    url: 'https://cdn.example/v.mp4',
    sha256: SHA,
    dims: { width: 1280, height: 720 },
    durationSec: 33,
    poster: 'https://cdn.example/p.webp',
    blurhash: 'LEHV6n',
    caption: 'roll-up',
    boards: ['SF Bay', 'sf-bay', 'Trains'],
  });

  it('maps imeta into columns', () => {
    const row = toVideoRow(makeEvent({ ...template, pubkey: AUTHOR, id: hex('11') }));
    expect(row).toEqual({
      event_id: hex('11'),
      pubkey: AUTHOR,
      created_at: template.created_at,
      url: 'https://cdn.example/v.mp4',
      sha256: SHA,
      poster_url: 'https://cdn.example/p.webp',
      duration: 33,
      width: 1280,
      height: 720,
      blurhash: 'LEHV6n',
      caption: 'roll-up',
      boards: ['sf-bay', 'trains'],
    });
  });

  it('falls back to top-level tags when imeta is absent', () => {
    const row = toVideoRow(
      makeEvent({
        kind: 22,
        tags: [
          ['url', 'https://cdn.example/v2.mp4'],
          ['x', SHA],
          ['duration', '9'],
          ['image', 'https://cdn.example/p2.webp'],
        ],
      }),
    );
    expect(row?.url).toBe('https://cdn.example/v2.mp4');
    expect(row?.sha256).toBe(SHA);
    expect(row?.duration).toBe(9);
    expect(row?.poster_url).toBe('https://cdn.example/p2.webp');
    expect(row?.width).toBeNull();
  });

  it('rejects a video with no url or blob hash', () => {
    expect(toVideoRow(makeEvent({ kind: 22, tags: [['t', 'sf']] }))).toBeNull();
  });
});

describe('toThreadRow (kind 1)', () => {
  it('maps the subject and the boards of a thread OP', () => {
    const template = buildThreadOp({
      subject: 'Who buffed the Alameda wall?',
      boards: ['SF Bay', 'oakland'],
      content: 'gone as of this morning',
      createdAt: 1_700_000_000,
    });
    const row = toThreadRow(makeEvent({ ...template, id: hex('55'), pubkey: AUTHOR }));

    expect(row).toEqual({
      event_id: hex('55'),
      pubkey: AUTHOR,
      subject: 'Who buffed the Alameda wall?',
      boards: ['sf-bay', 'oakland'],
      created_at: 1_700_000_000,
      happening_at: null,
    });
  });

  it('leaves the subject null when the OP has no subject tag', () => {
    const template = buildThreadOp({ boards: ['sf'], content: 'no title, still a thread' });
    const row = toThreadRow(makeEvent({ ...template, id: hex('56') }));

    expect(row.subject).toBeNull();
    expect(row.boards).toEqual(['sf']);
  });

  it('indexes a bare kind 1 with neither a subject nor a board', () => {
    // A thread with nothing on it is still a thread here — reachable by id and
    // by search — so it is indexed rather than dropped.
    const row = toThreadRow(makeEvent({ kind: KINDS.NOTE, id: hex('57'), content: 'oi' }));

    expect(row.subject).toBeNull();
    expect(row.boards).toEqual([]);
    expect(row.event_id).toBe(hex('57'));
  });

  it('does not copy the content or the expiry — those stay in events', () => {
    const template = buildThreadOp({
      subject: 'beef',
      content: 'secret sauce',
      expiration: 1_700_086_400,
    });
    const row = toThreadRow(makeEvent({ ...template }));

    expect(Object.keys(row).sort()).toEqual([
      'boards',
      'created_at',
      'event_id',
      'happening_at',
      'pubkey',
      'subject',
    ]);
    expect(JSON.stringify(row)).not.toContain('secret sauce');
  });

  it('dedupes and normalises repeated board tags', () => {
    const row = toThreadRow(
      makeEvent({
        kind: KINDS.NOTE,
        tags: [
          ['subject', 'x'],
          ['t', 'SF'],
          ['t', 'sf'],
          ['t', ''],
          ['t', 'Oakland'],
        ],
      }),
    );
    expect(row.boards).toEqual(['sf', 'oakland']);
  });
});

describe('toThreadRow: happenings', () => {
  const WHEN = 1_800_000_000;

  it('reads happening_at off a happening built by the protocol builder', () => {
    const template = buildThreadOp({
      subject: 'Yard jam',
      content: 'bring paint',
      boards: ['oakland'],
      happeningAt: WHEN,
      createdAt: 1_700_000_000,
    });
    const row = toThreadRow(makeEvent({ ...template, id: hex('58'), pubkey: AUTHOR }));

    expect(row.happening_at).toBe(WHEN);
    // The marker is a board slug like any other, so it lands in `boards` too.
    expect(row.boards).toEqual(['oakland', 'happening']);
  });

  it('is null for an ordinary thread', () => {
    const template = buildThreadOp({ content: 'no date on this', boards: ['sf'] });
    expect(toThreadRow(makeEvent({ ...template, id: hex('59') })).happening_at).toBeNull();
  });

  it('reads the date even when the happening marker is missing', () => {
    // The column is derived from the `when` tag alone — a hand-rolled event with
    // a date but no marker is still a dated thread, and the API's
    // `happening_at is not null` filter is what decides it shows up.
    const row = toThreadRow(
      makeEvent({ kind: KINDS.NOTE, id: hex('5a'), tags: [['when', String(WHEN)]] }),
    );
    expect(row.happening_at).toBe(WHEN);
    expect(row.boards).toEqual([]);
  });

  it('ignores a malformed when tag rather than storing junk', () => {
    for (const value of ['', 'soon', '-1', '0', '17e8']) {
      const row = toThreadRow(makeEvent({ kind: KINDS.NOTE, id: hex('5b'), tags: [['when', value]] }));
      expect(row.happening_at).toBeNull();
    }
  });

  it('reads no clock: the same event always maps to the same row', () => {
    const template = buildThreadOp({ content: 'jam', happeningAt: WHEN, createdAt: 1_700_000_000 });
    const event = makeEvent({ ...template, id: hex('5c') });
    expect(toThreadRow(event)).toEqual(toThreadRow(event));
  });
});

describe('toCommentRow (kind 1111)', () => {
  const parent = { id: hex('11'), pubkey: AUTHOR, kind: KINDS.FLICK };
  const root = { id: hex('22'), pubkey: hex('ef'), kind: KINDS.FLICK };

  it('separates root from parent', () => {
    const template = buildComment(parent, { content: 'clean', root });
    const row = toCommentRow(makeEvent({ ...template, id: hex('33'), pubkey: AUTHOR }));
    expect(row).toMatchObject({ root_id: root.id, parent_id: parent.id, content: 'clean' });
  });

  it('treats a top-level comment as its own root', () => {
    const template = buildComment(parent, { content: 'first' });
    const row = toCommentRow(makeEvent({ ...template }));
    expect(row?.root_id).toBe(parent.id);
    expect(row?.parent_id).toBe(parent.id);
  });

  it('drops a comment anchored to nothing', () => {
    expect(toCommentRow(makeEvent({ kind: 1111, content: 'orphan' }))).toBeNull();
  });
});

describe('toReportRow (kind 1984)', () => {
  it('maps an event report and its reason', () => {
    const template = buildReport(
      { pubkey: AUTHOR, eventId: hex('11'), kind: KINDS.FLICK },
      'illegal',
      { note: 'see this' },
    );
    const row = toReportRow(makeEvent({ ...template, pubkey: hex('99') }));
    expect(row).toMatchObject({
      reporter: hex('99'),
      target_pubkey: AUTHOR,
      target_event: hex('11'),
      reason: 'illegal',
      note: 'see this',
    });
  });

  it('maps a writer-level report', () => {
    const template = buildReport({ pubkey: AUTHOR }, 'spam');
    const row = toReportRow(makeEvent({ ...template }));
    expect(row?.target_event).toBeNull();
    expect(row?.target_pubkey).toBe(AUTHOR);
    expect(row?.reason).toBe('spam');
  });

  it('collapses an unknown reason to "other"', () => {
    const row = toReportRow(makeEvent({ kind: 1984, tags: [['p', AUTHOR, 'vibes']] }));
    expect(row?.reason).toBe('other');
  });

  it('drops a report with no target', () => {
    expect(toReportRow(makeEvent({ kind: 1984 }))).toBeNull();
  });
});

describe('toDeletionRow (kind 5, "buff")', () => {
  it('collects every e tag', () => {
    const template = buildBuff([hex('11'), hex('22'), hex('11')], { kinds: [20] });
    const row = toDeletionRow(makeEvent({ ...template, pubkey: AUTHOR }));
    expect(row?.targets).toEqual([hex('11'), hex('22')]);
    expect(row?.pubkey).toBe(AUTHOR);
  });

  it('drops a deletion naming nothing', () => {
    expect(toDeletionRow(makeEvent({ kind: 5 }))).toBeNull();
  });
});

describe('boards', () => {
  it('reads a registry object', () => {
    const event = makeEvent({
      kind: 30078,
      pubkey: AUTHOR,
      tags: [['d', 'boards']],
      content: JSON.stringify({
        boards: [
          { slug: 'SF Bay', title: 'Bay Area', kind: 'city' },
          { slug: 'sf-bay', title: 'dupe' },
          { slug: '', title: 'empty' },
          'junk',
        ],
      }),
    });
    expect(boardRowsFromRegistry(event)).toEqual([
      { slug: 'sf-bay', title: 'Bay Area', kind: 'city', created_by: AUTHOR, created_at: event.created_at },
    ]);
  });

  it('reads a bare registry array', () => {
    const event = makeEvent({ kind: 30078, content: JSON.stringify([{ slug: 'nyc' }]) });
    expect(boardRowsFromRegistry(event)[0]).toMatchObject({ slug: 'nyc', title: 'nyc', kind: 'city' });
  });

  it('ignores app data that is not the board registry', () => {
    const event = makeEvent({ kind: 30078, tags: [['d', 'modlist']], content: '[{"slug":"nyc"}]' });
    expect(boardRowsFromRegistry(event)).toEqual([]);
  });

  it('ignores unparseable registry content', () => {
    expect(boardRowsFromRegistry(makeEvent({ kind: 30078, content: '{' }))).toEqual([]);
  });

  it('discovers boards from a flick', () => {
    const event = makeEvent({ kind: 20, tags: [['t', 'Oakland']] });
    expect(boardRowsFromFlick(event)).toEqual([
      { slug: 'oakland', title: 'oakland', kind: 'city', created_by: null, created_at: event.created_at },
    ]);
  });

  it('classifies discovered boards by dash-namespace prefix', () => {
    const event = makeEvent({
      kind: 20,
      tags: [
        ['t', 'sf-bay'],
        ['t', 'type-throwie'],
        ['t', 'surface-street'],
        ['t', 'region-bay-area'],
        ['t', 'legal-permission'],
      ],
    });
    const rows = boardRowsFromFlick(event);
    expect(rows.map((r) => [r.slug, r.kind])).toEqual([
      ['sf-bay', 'city'],
      ['type-throwie', 'type'],
      ['surface-street', 'surface'],
      ['region-bay-area', 'region'],
      ['legal-permission', 'legal'],
    ]);
  });

  it('boardKindOf treats an unprefixed slug as a city', () => {
    expect(boardKindOf('oakland')).toBe('city');
    expect(boardKindOf('type-throwie')).toBe('type');
    expect(boardKindOf('surface-freight')).toBe('surface');
    expect(boardKindOf('region-pnw')).toBe('region');
    expect(boardKindOf('legal-permission')).toBe('legal');
  });

  it('boardKindOf keeps the happening marker out of the city list', () => {
    // Threads auto-register their board slugs, so without this a happening
    // would register a *city* called "happening" in GET /boards?kind=city.
    expect(boardKindOf('happening')).toBe('happening');
  });

  it('reads a region per registry entry', () => {
    const event = makeEvent({
      kind: 30078,
      pubkey: AUTHOR,
      tags: [['d', 'boards']],
      content: JSON.stringify({
        boards: [
          { slug: 'region-bay-area', title: 'Bay Area', kind: 'region' },
          { slug: 'sf-bay', title: 'SF / Bay', kind: 'city', region: 'region-bay-area' },
          { slug: 'oak', kind: 'city' },
        ],
      }),
    });
    const rows = boardRowsFromRegistry(event);
    expect(rows[0]?.region_slug).toBeUndefined();
    expect(rows[1]?.region_slug).toBe('region-bay-area');
    expect(rows[2]?.region_slug).toBeUndefined();
  });
});

describe('crewDefinitionRowFromEvent (kind 30078 d:crew)', () => {
  it('maps a crew definition built by @1nky/protocol', () => {
    const template = buildCrewDefinition({
      name: 'FASE',
      members: [hex('01'), hex('02')],
      founderPubkey: hex('03'),
      createdAt: 1_700_000_000,
    });
    const row = crewDefinitionRowFromEvent(
      makeEvent({ ...template, pubkey: AUTHOR, kind: KINDS.APP_DATA }),
    );
    expect(row).toEqual({
      crew_pubkey: AUTHOR,
      name: 'FASE',
      mark: null,
      founder_pubkey: hex('03'),
      founded_at: 1_700_000_000,
      members: [hex('01'), hex('02')],
      created_at: 1_700_000_000,
      updated_at: 1_700_000_000,
    });
  });

  it('merges p-tags and content.members, deduped', () => {
    const event = makeEvent({
      kind: KINDS.APP_DATA,
      pubkey: AUTHOR,
      tags: [
        ['d', CREW_DEFINITION_DTAG],
        ['p', hex('01')],
        ['p', hex('02')],
      ],
      content: JSON.stringify({ name: 'X', members: [hex('02'), hex('04'), 'not-hex'] }),
    });
    expect(crewDefinitionRowFromEvent(event)?.members).toEqual([hex('01'), hex('02'), hex('04')]);
  });

  it('returns null for a different d-tag, no name, or unparseable content', () => {
    expect(
      crewDefinitionRowFromEvent(
        makeEvent({ kind: KINDS.APP_DATA, tags: [['d', 'boards']], content: '{"name":"x"}' }),
      ),
    ).toBeNull();
    expect(
      crewDefinitionRowFromEvent(
        makeEvent({ kind: KINDS.APP_DATA, tags: [['d', 'crew']], content: '{"name":""}' }),
      ),
    ).toBeNull();
    expect(
      crewDefinitionRowFromEvent(
        makeEvent({ kind: KINDS.APP_DATA, tags: [['d', 'crew']], content: '{' }),
      ),
    ).toBeNull();
  });
});

describe('crewBadgeRowsFromRegistry (kind 30078 d:crew-badges)', () => {
  it('maps the site-key-signed badge attestation', () => {
    const template = buildCrewBadgeRegistry({ crewPubkeys: [hex('01'), hex('02')], createdAt: 123 });
    const rows = crewBadgeRowsFromRegistry(
      makeEvent({ ...template, pubkey: AUTHOR, kind: KINDS.APP_DATA }),
    );
    expect(rows).toEqual([
      { crew_pubkey: hex('01'), verified_at: 123, verified_by: AUTHOR },
      { crew_pubkey: hex('02'), verified_at: 123, verified_by: AUTHOR },
    ]);
  });

  it('dedupes and falls back to created_at when verifiedAt is missing', () => {
    const event = makeEvent({
      kind: KINDS.APP_DATA,
      pubkey: AUTHOR,
      created_at: 555,
      tags: [['d', CREW_BADGES_DTAG]],
      content: JSON.stringify({ badges: [{ pubkey: hex('01') }, { pubkey: hex('01') }] }),
    });
    expect(crewBadgeRowsFromRegistry(event)).toEqual([
      { crew_pubkey: hex('01'), verified_at: 555, verified_by: AUTHOR },
    ]);
  });

  it('returns nothing for a different d-tag or junk content', () => {
    expect(
      crewBadgeRowsFromRegistry(
        makeEvent({ kind: KINDS.APP_DATA, tags: [['d', 'crew']], content: '{"badges":[]}' }),
      ),
    ).toEqual([]);
    expect(
      crewBadgeRowsFromRegistry(
        makeEvent({ kind: KINDS.APP_DATA, tags: [['d', 'crew-badges']], content: '{' }),
      ),
    ).toEqual([]);
  });
});

describe('modBanActionFromEvent', () => {
  const target = hex('be');

  it('reads a ban, stamping banned_at from the event not the clock', () => {
    const event = makeEvent({
      ...buildModBan(target, 'ban', { reason: 'illegal', createdAt: 777 }),
      kind: KINDS.APP_DATA,
      pubkey: AUTHOR,
    });
    expect(modBanActionFromEvent(event)).toEqual({
      action: 'ban',
      subtree: false,
      row: { pubkey: target, reason: 'illegal', banned_at: 777, banned_by: AUTHOR },
    });
  });

  it('carries the subtree flag when the ban asks for the whole branch', () => {
    const event = makeEvent({
      ...buildModBan(target, 'ban', { reason: 'tag farm', subtree: true, createdAt: 777 }),
      kind: KINDS.APP_DATA,
      pubkey: AUTHOR,
    });
    expect(modBanActionFromEvent(event)?.subtree).toBe(true);
  });

  it('never marks an unban as a subtree action', () => {
    const event = makeEvent({
      ...buildModBan(target, 'unban', { subtree: true, createdAt: 778 }),
      kind: KINDS.APP_DATA,
      pubkey: AUTHOR,
    });
    expect(modBanActionFromEvent(event)?.subtree).toBe(false);
  });

  it('reads an unban, with no reason', () => {
    const event = makeEvent({
      ...buildModBan(target, 'unban', { createdAt: 778 }),
      kind: KINDS.APP_DATA,
      pubkey: AUTHOR,
    });
    expect(modBanActionFromEvent(event)?.action).toBe('unban');
    expect(modBanActionFromEvent(event)?.row.reason).toBeNull();
  });

  it('lowercases the signer so the moderator check is case-insensitive', () => {
    const event = makeEvent({
      ...buildModBan(target, 'ban', { createdAt: 1 }),
      kind: KINDS.APP_DATA,
      pubkey: AUTHOR.toUpperCase(),
    });
    expect(modBanActionFromEvent(event)?.row.banned_by).toBe(AUTHOR);
  });

  it('lets every other kind-30078 event through untouched', () => {
    expect(
      modBanActionFromEvent(
        makeEvent({ kind: KINDS.APP_DATA, tags: [['d', 'crew']], content: '{"name":"FASE"}' }),
      ),
    ).toBeNull();
    expect(
      modBanActionFromEvent(makeEvent({ kind: KINDS.APP_DATA, tags: [['d', 'boards']] })),
    ).toBeNull();
    expect(modBanActionFromEvent(makeEvent({ kind: KINDS.FLICK }))).toBeNull();
  });

  it('refuses a d-tag whose target is not a pubkey', () => {
    expect(
      modBanActionFromEvent(
        makeEvent({
          kind: KINDS.APP_DATA,
          tags: [['d', 'ban:nope']],
          content: '{"action":"ban"}',
        }),
      ),
    ).toBeNull();
  });
});

describe('inviteRowFromEvent', () => {
  const inviteId = 'ab12cd34ef567890';

  it('reads a mint, attributed to the signer and stamped from the event', () => {
    const event = makeEvent({
      ...buildInvite(inviteId, { note: 'kid from 3rd', createdAt: 777 }),
      kind: KINDS.APP_DATA,
      pubkey: AUTHOR,
    });
    expect(inviteRowFromEvent(event)).toEqual({
      invite_id: inviteId,
      inviter: AUTHOR,
      created_at: 777,
    });
  });

  it('lowercases the signer, so the not-banned check is case-insensitive', () => {
    const event = makeEvent({
      ...buildInvite(inviteId, { createdAt: 1 }),
      kind: KINDS.APP_DATA,
      pubkey: AUTHOR.toUpperCase(),
    });
    expect(inviteRowFromEvent(event)?.inviter).toBe(AUTHOR);
  });

  it('lets every other kind-30078 event through untouched', () => {
    expect(
      inviteRowFromEvent(
        makeEvent({ kind: KINDS.APP_DATA, tags: [['d', 'crew']], content: '{"name":"FASE"}' }),
      ),
    ).toBeNull();
    expect(
      inviteRowFromEvent(makeEvent({ kind: KINDS.APP_DATA, tags: [['d', `ban:${hex('be')}`]], content: '{"action":"ban"}' })),
    ).toBeNull();
    expect(inviteRowFromEvent(makeEvent({ kind: KINDS.FLICK }))).toBeNull();
  });

  it('refuses a d-tag whose id is not 16-64 hex', () => {
    expect(
      inviteRowFromEvent(
        makeEvent({ kind: KINDS.APP_DATA, tags: [['d', 'invite:short']], content: '{"v":1}' }),
      ),
    ).toBeNull();
  });
});

describe('inviteRedemptionFromEvent', () => {
  const inviteId = 'ab12cd34ef567890';
  const inviter = hex('1a');

  it('reads the claim off a kind 0 — every field, none of it trusted yet', () => {
    const event = makeEvent({
      ...buildProfile({
        tag: 'NEWJACK',
        invite: { inviteId, inviterPubkey: inviter },
        createdAt: 900,
      }),
      kind: KINDS.PROFILE,
      pubkey: AUTHOR,
    });
    expect(inviteRedemptionFromEvent(event)).toEqual({
      invite_id: inviteId,
      inviter,
      child: AUTHOR,
      redeemed_at: 900,
    });
  });

  it('is null for a profile that redeems nothing', () => {
    const event = makeEvent({ ...buildProfile({ tag: 'SMOG' }), kind: KINDS.PROFILE });
    expect(inviteRedemptionFromEvent(event)).toBeNull();
  });

  it('is null for a malformed tag and for the wrong kind', () => {
    expect(
      inviteRedemptionFromEvent(
        makeEvent({ kind: KINDS.PROFILE, tags: [['invite', 'short', inviter]] }),
      ),
    ).toBeNull();
    expect(
      inviteRedemptionFromEvent(
        makeEvent({ kind: KINDS.PROFILE, tags: [['invite', inviteId, 'nope']] }),
      ),
    ).toBeNull();
    expect(
      inviteRedemptionFromEvent(
        makeEvent({ kind: KINDS.NOTE, tags: [['invite', inviteId, inviter]] }),
      ),
    ).toBeNull();
  });

  it('lowercases both sides and the child', () => {
    const event = makeEvent({
      kind: KINDS.PROFILE,
      tags: [['invite', inviteId.toUpperCase(), inviter.toUpperCase()]],
      pubkey: AUTHOR.toUpperCase(),
    });
    expect(inviteRedemptionFromEvent(event)).toMatchObject({
      invite_id: inviteId,
      inviter,
      child: AUTHOR,
    });
  });
});

describe('routeOf', () => {
  it('routes every kind 1NKY stores', () => {
    expect(routeOf(KINDS.PROFILE)).toBe('profile');
    expect(routeOf(KINDS.FLICK)).toBe('flick');
    expect(routeOf(KINDS.VIDEO)).toBe('video');
    expect(routeOf(KINDS.COMMENT)).toBe('comment');
    expect(routeOf(KINDS.REPORT)).toBe('report');
    expect(routeOf(KINDS.DELETE)).toBe('deletion');
    expect(routeOf(KINDS.APP_DATA)).toBe('registry');
    expect(routeOf(KINDS.NOTE)).toBe('thread');
    expect(routeOf(KINDS.MUTE_LIST)).toBe('event');
  });
});
