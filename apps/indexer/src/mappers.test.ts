import { buildBuff, buildComment, buildFlick, buildProfile, buildReport, KINDS } from '@1nky/protocol';
import { describe, expect, it } from 'vitest';

import {
  boardRowsFromFlick,
  boardRowsFromRegistry,
  boardsOf,
  expirationOf,
  isExpired,
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
    });
    const row = toProfileRow(makeEvent({ ...template, pubkey: AUTHOR, kind: KINDS.PROFILE }));

    expect(row).toMatchObject({
      pubkey: AUTHOR,
      tag_name: 'SMOG',
      city: 'sf-bay',
      about: 'panels and rooftops',
      avatar_sha256: SHA,
    });
    expect(row.first_seen).toBe(row.updated_at);
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
    });
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
});

describe('routeOf', () => {
  it('routes every kind 1NKY stores', () => {
    expect(routeOf(KINDS.PROFILE)).toBe('profile');
    expect(routeOf(KINDS.FLICK)).toBe('flick');
    expect(routeOf(KINDS.COMMENT)).toBe('comment');
    expect(routeOf(KINDS.REPORT)).toBe('report');
    expect(routeOf(KINDS.DELETE)).toBe('deletion');
    expect(routeOf(KINDS.APP_DATA)).toBe('registry');
    expect(routeOf(KINDS.NOTE)).toBe('event');
    expect(routeOf(KINDS.MUTE_LIST)).toBe('event');
  });
});
