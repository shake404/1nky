import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import {
  beefExpiration,
  boardTag,
  buildBuff,
  buildComment,
  buildCrewBadgeRegistry,
  buildCrewDefinition,
  buildCrewProfile,
  buildExpiration,
  buildFlick,
  buildInvite,
  buildModBan,
  buildMuteList,
  buildProfile,
  buildReport,
  buildThreadOp,
  buildVideo,
  CREW_BADGES_DTAG,
  CREW_DEFINITION_DTAG,
  decodeInviteCode,
  encodeInviteCode,
  HAPPENING_BOARD,
  HAPPENING_GRACE_SECONDS,
  imetaTag,
  INVITE_DTAG_PREFIX,
  inviteRedemptionTag,
  isSubtreeBan,
  normalizeBoard,
  parseInvite,
  parseInviteRedemption,
  parseModBan,
  parseWhen,
  PROFILE_BIO_MAX,
  videoImetaTag,
  whenTag,
} from './builders.js';
import { fingerprint } from './mark.js';
import { GRAF_TYPES, LEGAL_PERMISSION_TAG, parseFacets, SURFACES, typeTag } from './facets.js';
import { KINDS } from './kinds.js';
import type { EventRef, Tag } from './types.js';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);
const HEX_D = 'd'.repeat(64);

const find = (tags: Tag[], name: string): Tag[] => tags.filter((t) => t[0] === name);
const first = (tags: Tag[], name: string): Tag | undefined => tags.find((t) => t[0] === name);

const FIXED = 1_800_000_000;

describe('tag helpers', () => {
  it('normalizeBoard slugifies', () => {
    expect(normalizeBoard('  SF Bay ')).toBe('sf-bay');
    expect(normalizeBoard('#Oakland')).toBe('oakland');
    expect(normalizeBoard('New York City!')).toBe('new-york-city');
  });

  it('boardTag emits a t tag', () => {
    expect(boardTag('SF Bay')).toEqual(['t', 'sf-bay']);
  });

  it('buildExpiration emits a NIP-40 tag', () => {
    expect(buildExpiration(FIXED)).toEqual(['expiration', '1800000000']);
    expect(() => buildExpiration(0)).toThrow(TypeError);
    expect(() => buildExpiration(1.5)).toThrow(TypeError);
  });

  it('beefExpiration maps the durations, pinned never expires', () => {
    expect(beefExpiration('24h', FIXED)).toBe(FIXED + 86_400);
    expect(beefExpiration('72h', FIXED)).toBe(FIXED + 259_200);
    expect(beefExpiration('7d', FIXED)).toBe(FIXED + 604_800);
    expect(beefExpiration('pinned', FIXED)).toBeNull();
  });

  it('imetaTag packs NIP-92 key/value pairs into one tag', () => {
    const tag = imetaTag({
      url: 'https://m.1nky.com/' + HEX_A,
      sha256: HEX_A,
      dims: { width: 1080, height: 1350 },
      blurhash: 'LEHV6nWB2yk8',
      alt: 'burner on a roll-down',
      size: 204_800,
    });
    expect(tag[0]).toBe('imeta');
    expect(tag).toContain(`url https://m.1nky.com/${HEX_A}`);
    expect(tag).toContain('m image/webp');
    expect(tag).toContain(`x ${HEX_A}`);
    expect(tag).toContain('dim 1080x1350');
    expect(tag).toContain('blurhash LEHV6nWB2yk8');
    expect(tag).toContain('alt burner on a roll-down');
    expect(tag).toContain('size 204800');
  });
});

describe('buildProfile', () => {
  it('is kind 0 with the tag in the content JSON', () => {
    const ev = buildProfile({ tag: 'SEKT', city: 'SF Bay', avatarSha256: HEX_A, createdAt: FIXED });
    expect(ev.kind).toBe(KINDS.PROFILE);
    expect(ev.kind).toBe(0);
    expect(ev.created_at).toBe(FIXED);
    expect(JSON.parse(ev.content)).toEqual({
      name: 'SEKT',
      city: 'sf-bay',
      avatar_sha256: HEX_A,
    });
  });

  it('omits absent fields and rejects an empty tag', () => {
    expect(JSON.parse(buildProfile({ tag: 'ZERO' }).content)).toEqual({ name: 'ZERO' });
    expect(() => buildProfile({ tag: '   ' })).toThrow(TypeError);
    expect(() => buildProfile({ tag: 'X', avatarSha256: 'nope' })).toThrow(TypeError);
  });

  it('serialises the bio as `about` for ecosystem compatibility', () => {
    const ev = buildProfile({ tag: 'SEKT', bio: '  panels only  ', createdAt: FIXED });
    expect(JSON.parse(ev.content)).toEqual({ name: 'SEKT', about: 'panels only' });
  });

  it('keeps the bio alongside every other field', () => {
    const ev = buildProfile({
      tag: 'SEKT',
      city: 'SF Bay',
      bio: 'rooftops',
      avatarSha256: HEX_A,
      createdAt: FIXED,
    });
    expect(JSON.parse(ev.content)).toEqual({
      name: 'SEKT',
      city: 'sf-bay',
      about: 'rooftops',
      avatar_sha256: HEX_A,
    });
  });

  it('omits an empty bio and refuses an oversized one', () => {
    expect(JSON.parse(buildProfile({ tag: 'X', bio: '   ' }).content)).toEqual({ name: 'X' });
    expect(JSON.parse(buildProfile({ tag: 'X', bio: '' }).content)).toEqual({ name: 'X' });
    expect(() => buildProfile({ tag: 'X', bio: 'y'.repeat(PROFILE_BIO_MAX + 1) })).toThrow(TypeError);
    expect(() =>
      buildProfile({ tag: 'X', bio: 'y'.repeat(PROFILE_BIO_MAX) }),
    ).not.toThrow();
  });

  it('serialises self-declared crews, lowercased and deduped', () => {
    const ev = buildProfile({ tag: 'SEKT', crews: [HEX_A, HEX_A, '  ' + HEX_B + '  '] });
    expect(JSON.parse(ev.content)).toEqual({ name: 'SEKT', crews: [HEX_A, HEX_B] });
  });

  it('omits crews when none are passed (additive — no shape change)', () => {
    expect(JSON.parse(buildProfile({ tag: 'SEKT' }).content)).toEqual({ name: 'SEKT' });
  });
});

describe('buildFlick', () => {
  const flick = buildFlick({
    url: 'https://m.1nky.com/' + HEX_A,
    sha256: HEX_A,
    dims: { width: 1080, height: 1350 },
    blurhash: 'LEHV6nWB2yk8',
    alt: 'panel on the 4th street line',
    boards: ['SF Bay', 'sf-bay', 'Trains'],
    caption: 'all city',
    createdAt: FIXED,
  });

  it('is kind 20', () => {
    expect(flick.kind).toBe(KINDS.FLICK);
    expect(flick.kind).toBe(20);
    expect(flick.content).toBe('all city');
  });

  it('carries one imeta tag plus top-level x and m for indexing', () => {
    expect(find(flick.tags, 'imeta')).toHaveLength(1);
    expect(first(flick.tags, 'x')).toEqual(['x', HEX_A]);
    expect(first(flick.tags, 'm')).toEqual(['m', 'image/webp']);
    expect(first(flick.tags, 'alt')).toEqual(['alt', 'panel on the 4th street line']);
  });

  it('emits a deduped t tag per board', () => {
    expect(find(flick.tags, 't')).toEqual([
      ['t', 'sf-bay'],
      ['t', 'trains'],
    ]);
  });

  it('adds an expiration tag only when asked', () => {
    expect(first(flick.tags, 'expiration')).toBeUndefined();
    const ephemeral = buildFlick({
      url: 'https://m.1nky.com/' + HEX_A,
      sha256: HEX_A,
      dims: { width: 10, height: 10 },
      expiration: FIXED,
    });
    expect(first(ephemeral.tags, 'expiration')).toEqual(['expiration', String(FIXED)]);
  });

  it('rejects a bad blob hash or missing url', () => {
    const base = { url: 'https://x/y', sha256: HEX_A, dims: { width: 1, height: 1 } };
    expect(() => buildFlick({ ...base, sha256: 'short' })).toThrow(TypeError);
    expect(() => buildFlick({ ...base, url: '' })).toThrow(TypeError);
  });

  it('emits dash-namespaced facet t tags alongside the city boards', () => {
    const ev = buildFlick({
      url: 'https://m.1nky.com/' + HEX_A,
      sha256: HEX_A,
      dims: { width: 4, height: 5 },
      boards: ['sf-bay'],
      types: ['throwie'],
      surfaces: ['street'],
      region: 'Bay Area',
      legalPermission: true,
      createdAt: FIXED,
    });
    expect(find(ev.tags, 't')).toEqual([
      ['t', 'sf-bay'],
      ['t', 'type-throwie'],
      ['t', 'surface-street'],
      ['t', 'region-bay-area'],
      ['t', 'legal-permission'],
    ]);
    // And they round-trip through parseFacets.
    expect(parseFacets(ev.tags)).toEqual({
      city: 'sf-bay',
      region: 'bay-area',
      types: ['throwie'],
      surfaces: ['street'],
      legalPermission: true,
    });
  });

  it('dedupes a facet slug supplied both as a board and as a facet', () => {
    const ev = buildFlick({
      url: 'https://m.1nky.com/' + HEX_A,
      sha256: HEX_A,
      dims: { width: 4, height: 5 },
      boards: ['type-throwie'],
      types: ['throwie'],
      createdAt: FIXED,
    });
    expect(find(ev.tags, 't')).toEqual([['t', 'type-throwie']]);
  });

  it('accepts every fixed graf type and surface without throwing', () => {
    for (const type of GRAF_TYPES) expect(typeTag(type)[1]).toBe(`type-${type}`);
    for (const surface of SURFACES) {
      const ev = buildFlick({
        url: 'https://m.1nky.com/' + HEX_A,
        sha256: HEX_A,
        dims: { width: 4, height: 5 },
        surfaces: [surface],
        createdAt: FIXED,
      });
      expect(first(ev.tags, 't')).toEqual(['t', `surface-${surface}`]);
    }
    expect(LEGAL_PERMISSION_TAG).toBe('legal-permission');
  });
});

describe('videoImetaTag', () => {
  it('packs NIP-92 + NIP-71 fields into one tag', () => {
    const tag = videoImetaTag({
      url: 'https://m.1nky.com/' + HEX_A,
      sha256: HEX_A,
      dims: { width: 1280, height: 720 },
      durationSec: 42,
      poster: 'https://m.1nky.com/' + HEX_B,
      blurhash: 'LEHV6nWB2yk8',
      alt: 'roll-up on the 4th street line',
      size: 1_048_576,
    });
    expect(tag[0]).toBe('imeta');
    expect(tag).toContain(`url https://m.1nky.com/${HEX_A}`);
    expect(tag).toContain('m video/mp4');
    expect(tag).toContain(`x ${HEX_A}`);
    expect(tag).toContain('dim 1280x720');
    expect(tag).toContain(`image https://m.1nky.com/${HEX_B}`);
    expect(tag).toContain('duration 42');
    expect(tag).toContain('blurhash LEHV6nWB2yk8');
    expect(tag).toContain('alt roll-up on the 4th street line');
    expect(tag).toContain('size 1048576');
  });

  it('rejects a bad blob hash', () => {
    expect(() =>
      videoImetaTag({
        url: 'https://x/y',
        sha256: 'short',
        dims: { width: 1, height: 1 },
        durationSec: 1,
        poster: 'https://x/p',
      }),
    ).toThrow(TypeError);
  });
});

describe('buildVideo', () => {
  const video = buildVideo({
    url: 'https://m.1nky.com/' + HEX_A,
    sha256: HEX_A,
    dims: { width: 1280, height: 720 },
    durationSec: 33,
    poster: 'https://m.1nky.com/' + HEX_B,
    blurhash: 'LEHV6nWB2yk8',
    alt: 'roll-up on the 4th street line',
    boards: ['SF Bay', 'sf-bay', 'Trains'],
    caption: 'all city',
    createdAt: FIXED,
  });

  it('is kind 22', () => {
    expect(video.kind).toBe(KINDS.VIDEO);
    expect(video.kind).toBe(22);
    expect(video.content).toBe('all city');
  });

  it('carries one imeta tag plus top-level x, m and duration for indexing', () => {
    expect(find(video.tags, 'imeta')).toHaveLength(1);
    expect(first(video.tags, 'x')).toEqual(['x', HEX_A]);
    expect(first(video.tags, 'm')).toEqual(['m', 'video/mp4']);
    expect(first(video.tags, 'duration')).toEqual(['duration', '33']);
    expect(first(video.tags, 'alt')).toEqual(['alt', 'roll-up on the 4th street line']);
    // The poster still rides inside imeta, not as a top-level tag.
    expect(first(video.tags, 'image')).toBeUndefined();
  });

  it('emits a deduped t tag per board', () => {
    expect(find(video.tags, 't')).toEqual([
      ['t', 'sf-bay'],
      ['t', 'trains'],
    ]);
  });

  it('adds an expiration tag only when asked', () => {
    expect(first(video.tags, 'expiration')).toBeUndefined();
    const ephemeral = buildVideo({
      url: 'https://m.1nky.com/' + HEX_A,
      sha256: HEX_A,
      dims: { width: 1280, height: 720 },
      durationSec: 5,
      poster: 'https://m.1nky.com/' + HEX_B,
      expiration: FIXED,
    });
    expect(first(ephemeral.tags, 'expiration')).toEqual(['expiration', String(FIXED)]);
  });

  it('rejects a bad blob hash, missing url/poster, or non-positive duration', () => {
    const base = {
      url: 'https://x/y',
      sha256: HEX_A,
      dims: { width: 1, height: 1 },
      durationSec: 1,
      poster: 'https://x/p',
    };
    expect(() => buildVideo({ ...base, sha256: 'short' })).toThrow(TypeError);
    expect(() => buildVideo({ ...base, url: '' })).toThrow(TypeError);
    expect(() => buildVideo({ ...base, poster: '' })).toThrow(TypeError);
    expect(() => buildVideo({ ...base, durationSec: 0 })).toThrow(TypeError);
    expect(() => buildVideo({ ...base, durationSec: -1 })).toThrow(TypeError);
  });

  it('emits dash-namespaced facet t tags alongside the city boards', () => {
    const ev = buildVideo({
      url: 'https://m.1nky.com/' + HEX_A,
      sha256: HEX_A,
      dims: { width: 1280, height: 720 },
      durationSec: 5,
      poster: 'https://m.1nky.com/' + HEX_B,
      boards: ['sf-bay'],
      types: ['piece'],
      surfaces: ['freight'],
      region: 'SoCal',
      legalPermission: false,
      createdAt: FIXED,
    });
    expect(find(ev.tags, 't')).toEqual([
      ['t', 'sf-bay'],
      ['t', 'type-piece'],
      ['t', 'surface-freight'],
      ['t', 'region-socal'],
    ]);
  });
});

describe('buildCrewProfile', () => {
  it('is buildProfile — a crew page is structurally a writer page', () => {
    expect(buildCrewProfile).toBe(buildProfile);
    const ev = buildCrewProfile({ tag: 'FASE', city: 'sf-bay', createdAt: FIXED });
    expect(ev.kind).toBe(KINDS.PROFILE);
    expect(JSON.parse(ev.content)).toEqual({ name: 'FASE', city: 'sf-bay' });
  });
});

describe('buildCrewDefinition', () => {
  it('is kind 30078 with d:crew, a p tag per member, and a JSON roster', () => {
    const ev = buildCrewDefinition({
      name: 'FASE',
      mark: fingerprint(HEX_A),
      members: [HEX_A, HEX_B, HEX_A],
      founderPubkey: HEX_C,
      createdAt: FIXED,
    });
    expect(ev.kind).toBe(KINDS.APP_DATA);
    expect(first(ev.tags, 'd')).toEqual(['d', CREW_DEFINITION_DTAG]);
    expect(first(ev.tags, 'd')?.[1]).toBe('crew');
    // Deduped p tags, one per member.
    expect(find(ev.tags, 'p')).toEqual([
      ['p', HEX_A],
      ['p', HEX_B],
    ]);
    const content = JSON.parse(ev.content) as Record<string, unknown>;
    expect(content['name']).toBe('FASE');
    expect(content['members']).toEqual([HEX_A, HEX_B]);
    expect(content['founderPubkey']).toBe(HEX_C);
    expect(content['mark']).toBe(fingerprint(HEX_A));
    expect(content['foundedAt']).toBe(FIXED);
  });

  it('carries optional links and omits founder/mark when absent', () => {
    const ev = buildCrewDefinition({
      name: 'MSK',
      members: [HEX_A],
      links: { instagram: 'https://ig.example/m' },
    });
    const content = JSON.parse(ev.content) as Record<string, unknown>;
    expect(content['links']).toEqual({ instagram: 'https://ig.example/m' });
    expect(content['founderPubkey']).toBeUndefined();
    expect(content['mark']).toBeUndefined();
  });

  it('rejects an empty name or a bad member pubkey', () => {
    expect(() => buildCrewDefinition({ name: '   ', members: [HEX_A] })).toThrow(TypeError);
    expect(() => buildCrewDefinition({ name: 'X', members: ['nope'] })).toThrow(TypeError);
  });
});

describe('buildCrewBadgeRegistry', () => {
  it('is kind 30078 with d:crew-badges, site-key-signed shape, and a mark per crew', () => {
    const ev = buildCrewBadgeRegistry({ crewPubkeys: [HEX_A, HEX_B, HEX_A], createdAt: FIXED });
    expect(ev.kind).toBe(KINDS.APP_DATA);
    expect(first(ev.tags, 'd')).toEqual(['d', CREW_BADGES_DTAG]);
    expect(first(ev.tags, 'd')?.[1]).toBe('crew-badges');
    const content = JSON.parse(ev.content) as { badges: { pubkey: string; mark: string; verifiedAt: number }[] };
    expect(content.badges).toEqual([
      { pubkey: HEX_A, mark: fingerprint(HEX_A), verifiedAt: FIXED },
      { pubkey: HEX_B, mark: fingerprint(HEX_B), verifiedAt: FIXED },
    ]);
  });

  it('rejects a malformed crew pubkey', () => {
    expect(() => buildCrewBadgeRegistry({ crewPubkeys: ['nope'] })).toThrow(TypeError);
  });
});

describe('buildThreadOp', () => {
  it('is kind 1 with subject and board tags', () => {
    const ev = buildThreadOp({
      content: 'who buffed the yard',
      subject: 'yard buffed',
      boards: ['SF Bay'],
      createdAt: FIXED,
    });
    expect(ev.kind).toBe(KINDS.NOTE);
    expect(ev.kind).toBe(1);
    expect(first(ev.tags, 'subject')).toEqual(['subject', 'yard buffed']);
    expect(first(ev.tags, 't')).toEqual(['t', 'sf-bay']);
  });

  it('becomes a beef thread with an expiration', () => {
    const expiry = beefExpiration('72h', FIXED);
    const ev = buildThreadOp({ content: 'beef', expiration: expiry ?? undefined });
    expect(first(ev.tags, 'expiration')).toEqual(['expiration', String(FIXED + 259_200)]);
  });

  it('carries no when tag and no happening slug by default', () => {
    const ev = buildThreadOp({ content: 'just a thread', boards: ['sf'], createdAt: FIXED });
    expect(first(ev.tags, 'when')).toBeUndefined();
    expect(find(ev.tags, 't')).toEqual([['t', 'sf']]);
    expect(first(ev.tags, 'expiration')).toBeUndefined();
    expect(parseWhen(ev)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Happenings
// ---------------------------------------------------------------------------

describe('the happening marker', () => {
  it('is a plain unprefixed board slug, so it rides the board machinery', () => {
    expect(HAPPENING_BOARD).toBe('happening');
    expect(normalizeBoard(HAPPENING_BOARD)).toBe(HAPPENING_BOARD);
    expect(boardTag(HAPPENING_BOARD)).toEqual(['t', 'happening']);
  });

  it('grants a week of grace after the event before NIP-40 removes it', () => {
    expect(HAPPENING_GRACE_SECONDS).toBe(604_800);
  });
});

describe('whenTag', () => {
  it('serialises a unix timestamp', () => {
    expect(whenTag(FIXED)).toEqual(['when', String(FIXED)]);
  });

  it('refuses anything that is not a positive whole number of seconds', () => {
    expect(() => whenTag(0)).toThrow(TypeError);
    expect(() => whenTag(-1)).toThrow(TypeError);
    expect(() => whenTag(1.5)).toThrow(TypeError);
    expect(() => whenTag(Number.NaN)).toThrow(TypeError);
  });
});

describe('parseWhen', () => {
  it('reads the when tag back', () => {
    expect(parseWhen({ tags: [['when', String(FIXED)]] })).toBe(FIXED);
  });

  it('is null when there is no when tag', () => {
    expect(parseWhen({ tags: [['t', 'sf'], ['subject', 'x']] })).toBeNull();
    expect(parseWhen({ tags: [] })).toBeNull();
  });

  it('steps over a malformed when tag and takes the first valid one', () => {
    expect(
      parseWhen({
        tags: [
          ['when'],
          ['when', ''],
          ['when', 'soon'],
          ['when', '-5'],
          ['when', '0'],
          ['when', '12.5'],
          ['when', String(FIXED)],
          ['when', String(FIXED + 1)],
        ],
      }),
    ).toBe(FIXED);
  });

  it('tolerates surrounding whitespace but not trailing junk', () => {
    expect(parseWhen({ tags: [['when', ` ${String(FIXED)} `]] })).toBe(FIXED);
    expect(parseWhen({ tags: [['when', '1800000000x']] })).toBeNull();
  });
});

describe('buildThreadOp as a happening', () => {
  const WHEN = FIXED + 86_400;

  it('appends a when tag and joins the happening board', () => {
    const ev = buildThreadOp({
      content: 'yard jam, bring paint',
      subject: 'Yard jam',
      boards: ['SF Bay'],
      happeningAt: WHEN,
      createdAt: FIXED,
    });

    expect(ev.kind).toBe(KINDS.NOTE);
    expect(first(ev.tags, 'when')).toEqual(['when', String(WHEN)]);
    expect(find(ev.tags, 't')).toEqual([['t', 'sf-bay'], ['t', 'happening']]);
    expect(parseWhen(ev)).toBe(WHEN);
  });

  it('expires seven days after the event when no expiration was passed', () => {
    const ev = buildThreadOp({ content: 'jam', happeningAt: WHEN, createdAt: FIXED });
    expect(first(ev.tags, 'expiration')).toEqual(['expiration', String(WHEN + HAPPENING_GRACE_SECONDS)]);
  });

  it('lets an explicit expiration win over the seven-day default', () => {
    const ev = buildThreadOp({
      content: 'jam',
      happeningAt: WHEN,
      expiration: WHEN + 60,
      createdAt: FIXED,
    });
    expect(find(ev.tags, 'expiration')).toEqual([['expiration', String(WHEN + 60)]]);
  });

  it('dedupes the happening slug when the caller also passes it as a board', () => {
    const ev = buildThreadOp({
      content: 'jam',
      boards: ['happening', 'oakland', 'Happening'],
      happeningAt: WHEN,
    });
    expect(find(ev.tags, 't')).toEqual([['t', 'happening'], ['t', 'oakland']]);
  });

  it('works with no boards at all', () => {
    const ev = buildThreadOp({ content: 'jam', happeningAt: WHEN });
    expect(find(ev.tags, 't')).toEqual([['t', 'happening']]);
  });

  it('refuses a bad date before building anything', () => {
    expect(() => buildThreadOp({ content: 'jam', happeningAt: 0 })).toThrow(TypeError);
    expect(() => buildThreadOp({ content: 'jam', happeningAt: 1.5 })).toThrow(TypeError);
  });

  it('is not read as a city by parseFacets', () => {
    const ev = buildThreadOp({ content: 'jam', boards: ['oakland'], happeningAt: WHEN });
    const facets = parseFacets(ev.tags);
    expect(facets.city).toBe('oakland');

    // And with no city at all, `happening` must not fill the slot.
    const bare = buildThreadOp({ content: 'jam', happeningAt: WHEN });
    expect(parseFacets(bare.tags).city).toBeNull();
  });
});

describe('buildComment', () => {
  const flick: EventRef = { id: HEX_A, pubkey: HEX_B, kind: KINDS.FLICK };
  const reply: EventRef = { id: HEX_C, pubkey: HEX_D, kind: KINDS.COMMENT };

  it('is kind 1111 and points both scopes at the root for a top-level comment', () => {
    const ev = buildComment(flick, { content: 'clean', createdAt: FIXED });
    expect(ev.kind).toBe(KINDS.COMMENT);
    expect(ev.kind).toBe(1111);
    expect(first(ev.tags, 'E')).toEqual(['E', HEX_A, '', HEX_B]);
    expect(first(ev.tags, 'K')).toEqual(['K', '20']);
    expect(first(ev.tags, 'P')).toEqual(['P', HEX_B, '']);
    expect(first(ev.tags, 'e')).toEqual(['e', HEX_A, '', HEX_B]);
    expect(first(ev.tags, 'k')).toEqual(['k', '20']);
    expect(first(ev.tags, 'p')).toEqual(['p', HEX_B, '']);
  });

  it('splits root scope from parent for a nested reply', () => {
    const ev = buildComment(reply, { content: 'nah', root: flick });
    expect(first(ev.tags, 'E')).toEqual(['E', HEX_A, '', HEX_B]);
    expect(first(ev.tags, 'K')).toEqual(['K', '20']);
    expect(first(ev.tags, 'P')).toEqual(['P', HEX_B, '']);
    expect(first(ev.tags, 'e')).toEqual(['e', HEX_C, '', HEX_D]);
    expect(first(ev.tags, 'k')).toEqual(['k', '1111']);
    expect(first(ev.tags, 'p')).toEqual(['p', HEX_D, '']);
  });

  it('threads relay hints through', () => {
    const ev = buildComment({ ...flick, relay: 'wss://relay.1nky.com' }, { content: 'x' });
    expect(first(ev.tags, 'e')?.[2]).toBe('wss://relay.1nky.com');
  });

  it('rejects malformed refs', () => {
    expect(() => buildComment({ id: 'x', pubkey: HEX_B, kind: 20 }, { content: 'x' })).toThrow(
      TypeError,
    );
  });
});

describe('buildBuff', () => {
  it('is kind 5 with one e tag per buffed event', () => {
    const ev = buildBuff([HEX_A, HEX_B], { kinds: [KINDS.FLICK], createdAt: FIXED });
    expect(ev.kind).toBe(KINDS.DELETE);
    expect(ev.kind).toBe(5);
    expect(find(ev.tags, 'e')).toEqual([
      ['e', HEX_A],
      ['e', HEX_B],
    ]);
    expect(find(ev.tags, 'k')).toEqual([['k', '20']]);
    expect(ev.content).toBe('');
  });

  it('requires at least one id and validates them', () => {
    expect(() => buildBuff([])).toThrow(TypeError);
    expect(() => buildBuff(['nope'])).toThrow(TypeError);
  });
});

describe('buildReport', () => {
  it('is kind 1984 and tags the event with the reason', () => {
    const ev = buildReport({ pubkey: HEX_B, eventId: HEX_A, kind: 20 }, 'illegal', {
      note: 'this is a threat',
      createdAt: FIXED,
    });
    expect(ev.kind).toBe(KINDS.REPORT);
    expect(ev.kind).toBe(1984);
    expect(first(ev.tags, 'e')).toEqual(['e', HEX_A, 'illegal']);
    expect(first(ev.tags, 'p')).toEqual(['p', HEX_B]);
    expect(first(ev.tags, 'k')).toEqual(['k', '20']);
    expect(ev.content).toBe('this is a threat');
  });

  it('puts the reason on the p tag when reporting a writer', () => {
    const ev = buildReport({ pubkey: HEX_B }, 'impersonation');
    expect(ev.tags).toEqual([['p', HEX_B, 'impersonation']]);
  });

  it('rejects a malformed pubkey', () => {
    expect(() => buildReport({ pubkey: 'nope' }, 'spam')).toThrow(TypeError);
  });
});

describe('buildModBan / parseModBan', () => {
  it('is kind 30078 keyed d=ban:<target> with a p tag and JSON body', () => {
    const ev = buildModBan(HEX_B, 'ban', { reason: 'illegal', createdAt: FIXED });
    expect(ev.kind).toBe(KINDS.APP_DATA);
    expect(first(ev.tags, 'd')).toEqual(['d', `ban:${HEX_B}`]);
    expect(first(ev.tags, 'p')).toEqual(['p', HEX_B]);
    expect(JSON.parse(ev.content)).toEqual({ action: 'ban', reason: 'illegal' });
  });

  it('round-trips through parseModBan, unban included', () => {
    const ban = buildModBan(HEX_B, 'ban', { reason: 'spam' });
    expect(parseModBan(ban)).toEqual({ targetPubkey: HEX_B, action: 'ban', reason: 'spam' });
    const unban = buildModBan(HEX_B, 'unban');
    expect(parseModBan(unban)).toEqual({ targetPubkey: HEX_B, action: 'unban', reason: null });
  });

  it('rejects a malformed target pubkey', () => {
    expect(() => buildModBan('nope', 'ban')).toThrow(TypeError);
  });

  it('parseModBan returns null for other app data and junk', () => {
    expect(parseModBan({ kind: 30078, tags: [['d', 'crew']], content: '{}' })).toBeNull();
    expect(parseModBan({ kind: 30078, tags: [['d', `ban:${HEX_B}`]], content: 'not json' })).toBeNull();
    expect(parseModBan({ kind: 30078, tags: [['d', 'ban:nope']], content: '{"action":"ban"}' })).toBeNull();
    expect(parseModBan({ kind: 30078, tags: [['d', `ban:${HEX_B}`]], content: '{"action":"nuke"}' })).toBeNull();
    expect(parseModBan({ kind: 1, tags: [['d', `ban:${HEX_B}`]], content: '{"action":"ban"}' })).toBeNull();
  });
});

describe('isSubtreeBan', () => {
  it('is false for an ordinary ban', () => {
    expect(isSubtreeBan(buildModBan(HEX_B, 'ban', { reason: 'spam' }))).toBe(false);
  });

  it('is true when the builder was asked for the whole branch', () => {
    const ev = buildModBan(HEX_B, 'ban', { reason: 'tag farm', subtree: true });
    expect(JSON.parse(ev.content)).toEqual({ action: 'ban', reason: 'tag farm', subtree: true });
    expect(isSubtreeBan(ev)).toBe(true);
  });

  it('is true from a reason prefix alone, for tooling with only a reason field', () => {
    expect(isSubtreeBan(buildModBan(HEX_B, 'ban', { reason: 'subtree: tag farm' }))).toBe(true);
    expect(isSubtreeBan(buildModBan(HEX_B, 'ban', { reason: 'SUBTREE: shouting' }))).toBe(true);
  });

  it('never cascades an unban, however it is spelled', () => {
    expect(isSubtreeBan(buildModBan(HEX_B, 'unban', { subtree: true }))).toBe(false);
    expect(isSubtreeBan(buildModBan(HEX_B, 'unban', { reason: 'subtree: sorry' }))).toBe(false);
    // The flag is not even emitted on an unban, so nothing downstream can read
    // it as a promise the indexer does not keep.
    expect(JSON.parse(buildModBan(HEX_B, 'unban', { subtree: true }).content)).toEqual({
      action: 'unban',
    });
  });

  it('is false for anything that is not a mod ban at all', () => {
    expect(isSubtreeBan({ kind: 30078, tags: [['d', 'crew']], content: '{"subtree":true}' })).toBe(
      false,
    );
    expect(isSubtreeBan({ kind: 1, tags: [], content: '{"subtree":true}' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invites — "getting put on"
// ---------------------------------------------------------------------------

const INVITE_ID = 'ab12cd34ef567890';

describe('buildInvite / parseInvite', () => {
  it('is kind 30078 keyed d=invite:<id> with a versioned JSON body', () => {
    const ev = buildInvite(INVITE_ID, { createdAt: FIXED });
    expect(ev.kind).toBe(KINDS.APP_DATA);
    expect(ev.tags).toEqual([['d', `${INVITE_DTAG_PREFIX}${INVITE_ID}`]]);
    expect(JSON.parse(ev.content)).toEqual({ v: 1 });
    expect(ev.created_at).toBe(FIXED);
  });

  it('carries an optional note', () => {
    const ev = buildInvite(INVITE_ID, { note: 'kid from 3rd' });
    expect(JSON.parse(ev.content)).toEqual({ v: 1, note: 'kid from 3rd' });
  });

  it('round-trips through parseInvite', () => {
    expect(parseInvite(buildInvite(INVITE_ID))).toEqual({ inviteId: INVITE_ID });
    expect(parseInvite(buildInvite('a'.repeat(64)))).toEqual({ inviteId: 'a'.repeat(64) });
  });

  it('rejects an id that is not 16-64 lowercase hex', () => {
    for (const bad of ['', 'short', 'ab12cd34ef56789', 'a'.repeat(65), 'AB12CD34EF567890', 'zz12cd34ef567890']) {
      expect(() => buildInvite(bad)).toThrow(TypeError);
    }
  });

  it('parseInvite returns null for other app data and junk', () => {
    expect(parseInvite({ kind: 30078, tags: [['d', 'crew']], content: '{"v":1}' })).toBeNull();
    expect(parseInvite({ kind: 30078, tags: [], content: '{"v":1}' })).toBeNull();
    expect(parseInvite({ kind: 30078, tags: [['d', 'invite:nope']], content: '{"v":1}' })).toBeNull();
    expect(parseInvite({ kind: 1, tags: [['d', `invite:${INVITE_ID}`]], content: '{"v":1}' })).toBeNull();
  });

  it('reads an uppercase id case-insensitively but refuses a future version', () => {
    expect(
      parseInvite({ kind: 30078, tags: [['d', `invite:${INVITE_ID.toUpperCase()}`]], content: '' }),
    ).toEqual({ inviteId: INVITE_ID });
    expect(
      parseInvite({ kind: 30078, tags: [['d', `invite:${INVITE_ID}`]], content: '{"v":2}' }),
    ).toBeNull();
    // Unparseable content is still a v1 invite: the `d` tag is the identity.
    expect(
      parseInvite({ kind: 30078, tags: [['d', `invite:${INVITE_ID}`]], content: 'not json' }),
    ).toEqual({ inviteId: INVITE_ID });
  });
});

describe('inviteRedemptionTag / parseInviteRedemption', () => {
  it('is ["invite", id, inviterPubkey]', () => {
    expect(inviteRedemptionTag(INVITE_ID, HEX_A)).toEqual(['invite', INVITE_ID, HEX_A]);
  });

  it('rejects a malformed half', () => {
    expect(() => inviteRedemptionTag('nope', HEX_A)).toThrow(TypeError);
    expect(() => inviteRedemptionTag(INVITE_ID, 'nope')).toThrow(TypeError);
  });

  it('rides on a kind-0 profile and round-trips', () => {
    const ev = buildProfile({ tag: 'SMOG', invite: { inviteId: INVITE_ID, inviterPubkey: HEX_A } });
    expect(ev.kind).toBe(KINDS.PROFILE);
    expect(first(ev.tags, 'invite')).toEqual(['invite', INVITE_ID, HEX_A]);
    expect(parseInviteRedemption(ev)).toEqual({ inviteId: INVITE_ID, inviterPubkey: HEX_A });
    // Still an ordinary profile otherwise.
    expect(JSON.parse(ev.content)).toEqual({ name: 'SMOG' });
  });

  it('is backward compatible: a profile without an invite has no invite tag', () => {
    const ev = buildProfile({ tag: 'SMOG', city: 'SF Bay' });
    expect(ev.tags).toEqual([]);
    expect(parseInviteRedemption(ev)).toBeNull();
  });

  it('takes the first invite tag, so a second cannot launder a different inviter', () => {
    expect(
      parseInviteRedemption({
        kind: 0,
        tags: [
          ['invite', INVITE_ID, HEX_A],
          ['invite', INVITE_ID, HEX_B],
        ],
      }),
    ).toEqual({ inviteId: INVITE_ID, inviterPubkey: HEX_A });
  });

  it('returns null for junk and for the wrong kind', () => {
    expect(parseInviteRedemption({ kind: 0, tags: [] })).toBeNull();
    expect(parseInviteRedemption({ kind: 0, tags: [['invite', 'nope', HEX_A]] })).toBeNull();
    expect(parseInviteRedemption({ kind: 0, tags: [['invite', INVITE_ID, 'nope']] })).toBeNull();
    expect(parseInviteRedemption({ kind: 0, tags: [['invite', INVITE_ID]] })).toBeNull();
    expect(parseInviteRedemption({ kind: 1, tags: [['invite', INVITE_ID, HEX_A]] })).toBeNull();
  });
});

describe('encodeInviteCode / decodeInviteCode', () => {
  it('round-trips <inviteId>.<inviterPubkey>', () => {
    const code = encodeInviteCode(INVITE_ID, HEX_A);
    expect(code).toBe(`${INVITE_ID}.${HEX_A}`);
    expect(decodeInviteCode(code)).toEqual({ inviteId: INVITE_ID, inviterPubkey: HEX_A });
  });

  it('tolerates surrounding whitespace and mixed case', () => {
    expect(decodeInviteCode(`  ${INVITE_ID.toUpperCase()}.${HEX_A.toUpperCase()}  `)).toEqual({
      inviteId: INVITE_ID,
      inviterPubkey: HEX_A,
    });
  });

  it('refuses to encode a malformed half', () => {
    expect(() => encodeInviteCode('nope', HEX_A)).toThrow(TypeError);
    expect(() => encodeInviteCode(INVITE_ID, 'nope')).toThrow(TypeError);
  });

  it('decodes junk to null rather than throwing', () => {
    for (const bad of [
      '',
      'nope',
      INVITE_ID,
      HEX_A,
      `${INVITE_ID}.`,
      `.${HEX_A}`,
      `${INVITE_ID}.${HEX_A}.${HEX_B}`,
      `${INVITE_ID}.${'z'.repeat(64)}`,
      `short.${HEX_A}`,
      `${INVITE_ID}:${HEX_A}`,
    ]) {
      expect(decodeInviteCode(bad)).toBeNull();
    }
  });
});

describe('buildMuteList', () => {
  it('is kind 10000 with deduped p tags', () => {
    const ev = buildMuteList([HEX_A, HEX_B, HEX_A], {
      events: [HEX_C],
      boards: ['Beef'],
      words: ['SNITCH'],
      createdAt: FIXED,
    });
    expect(ev.kind).toBe(KINDS.MUTE_LIST);
    expect(ev.kind).toBe(10000);
    expect(find(ev.tags, 'p')).toEqual([
      ['p', HEX_A],
      ['p', HEX_B],
    ]);
    expect(find(ev.tags, 'e')).toEqual([['e', HEX_C]]);
    expect(find(ev.tags, 't')).toEqual([['t', 'beef']]);
    expect(find(ev.tags, 'word')).toEqual([['word', 'snitch']]);
    expect(ev.content).toBe('');
  });

  it('allows an empty list (clearing your mutes)', () => {
    expect(buildMuteList([]).tags).toEqual([]);
  });
});

describe('every builder produces a signable template', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const ref: EventRef = { id: HEX_A, pubkey: pk, kind: KINDS.FLICK };

  const templates = {
    profile: buildProfile({ tag: 'SEKT' }),
    flick: buildFlick({
      url: 'https://m.1nky.com/' + HEX_A,
      sha256: HEX_A,
      dims: { width: 4, height: 5 },
    }),
    video: buildVideo({
      url: 'https://m.1nky.com/' + HEX_A,
      sha256: HEX_A,
      dims: { width: 1280, height: 720 },
      durationSec: 9,
      poster: 'https://m.1nky.com/' + HEX_B,
    }),
    threadOp: buildThreadOp({ content: 'hi', boards: ['sf-bay'] }),
    comment: buildComment(ref, { content: 'clean' }),
    buff: buildBuff([HEX_A]),
    report: buildReport({ pubkey: pk }, 'spam'),
    muteList: buildMuteList([HEX_B]),
    crewDefinition: buildCrewDefinition({ name: 'FASE', members: [pk, HEX_B] }),
    crewBadgeRegistry: buildCrewBadgeRegistry({ crewPubkeys: [pk] }),
  };

  it.each(Object.entries(templates))('%s signs and verifies', (_name, tpl) => {
    expect(Number.isInteger(tpl.created_at)).toBe(true);
    expect(Object.keys(tpl).sort()).toEqual(['content', 'created_at', 'kind', 'tags']);
    const signed = finalizeEvent(tpl, sk);
    expect(signed.pubkey).toBe(pk);
    expect(signed.kind).toBe(tpl.kind);
    expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyEvent(signed)).toBe(true);
  });

  it('detects a tampered event', () => {
    const signed = finalizeEvent(templates.flick, sk);
    // Rebuilt field-by-field so nostr-tools' cached "verified" symbol is not
    // carried over from the original.
    const tampered = {
      id: signed.id,
      pubkey: signed.pubkey,
      created_at: signed.created_at,
      kind: signed.kind,
      tags: signed.tags,
      content: 'tampered',
      sig: signed.sig,
    };
    expect(verifyEvent(tampered)).toBe(false);
  });
});
