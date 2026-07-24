import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import {
  beefExpiration,
  boardTag,
  buildBuff,
  buildComment,
  buildExpiration,
  buildFlick,
  buildMuteList,
  buildProfile,
  buildReport,
  buildThreadOp,
  imetaTag,
  normalizeBoard,
} from './builders.js';
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
    threadOp: buildThreadOp({ content: 'hi', boards: ['sf-bay'] }),
    comment: buildComment(ref, { content: 'clean' }),
    buff: buildBuff([HEX_A]),
    report: buildReport({ pubkey: pk }, 'spam'),
    muteList: buildMuteList([HEX_B]),
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
