import { finalizeEvent, generateSecretKey, getPublicKey, KINDS } from '@1nky/protocol';
import { describe, expect, it } from 'vitest';
import { flickFromEvent, parseFeedResponse } from './feed.js';
import { flickTemplate, parseUploadResponse } from './flicks.js';

const secret = generateSecretKey();
const pubkey = getPublicKey(secret);
const HASH = 'c'.repeat(64);

function signedFlick(caption = 'up'): ReturnType<typeof finalizeEvent> {
  const upload = parseUploadResponse({
    sha256: HASH,
    url: 'https://media.example/ccc',
    size: 1234,
    type: 'image/webp',
  });
  return finalizeEvent(flickTemplate(upload, { width: 1600, height: 900 }, { caption }), secret);
}

describe('flickFromEvent', () => {
  it('reads a flick straight back out of its own event', () => {
    const flick = flickFromEvent(signedFlick('rooftop'));

    expect(flick).not.toBeNull();
    expect(flick?.sha256).toBe(HASH);
    expect(flick?.url).toBe('https://media.example/ccc');
    expect(flick?.width).toBe(1600);
    expect(flick?.height).toBe(900);
    expect(flick?.caption).toBe('rooftop');
    expect(flick?.pubkey).toBe(pubkey);
    expect(flick?.mark).toHaveLength(6);
  });

  it('ignores anything that is not a flick', () => {
    const note = finalizeEvent({ kind: KINDS.NOTE, tags: [], content: 'hi', created_at: 1 }, secret);
    expect(flickFromEvent(note)).toBeNull();
  });

  it('drops a flick with no usable picture', () => {
    const broken = finalizeEvent(
      { kind: KINDS.FLICK, tags: [['imeta', 'url https://x/y']], content: '', created_at: 1 },
      secret,
    );
    expect(flickFromEvent(broken)).toBeNull();
  });
});

describe('parseFeedResponse', () => {
  it('accepts denormalised rows from the read API', () => {
    const page = parseFeedResponse({
      items: [
        {
          id: 'd'.repeat(64),
          pubkey,
          created_at: 1_700_000_000,
          url: 'https://media.example/ddd',
          sha256: HASH,
          width: 1200,
          height: 1600,
          caption: 'a wall',
          name: 'SHOCK',
        },
      ],
      cursor: '1699999999',
    });

    expect(page.flicks).toHaveLength(1);
    expect(page.flicks[0]?.writer).toBe('SHOCK');
    expect(page.cursor).toBe('1699999999');
  });

  it('accepts raw events just as happily', () => {
    const page = parseFeedResponse({ items: [signedFlick()] });
    expect(page.flicks).toHaveLength(1);
    expect(page.cursor).toBeNull();
  });

  it('skips rows it cannot render instead of throwing', () => {
    const page = parseFeedResponse({ items: [{ nope: true }, null, signedFlick()] });
    expect(page.flicks).toHaveLength(1);
  });

  it('survives an empty or malformed body', () => {
    expect(parseFeedResponse({}).flicks).toEqual([]);
    expect(parseFeedResponse(null).flicks).toEqual([]);
    expect(parseFeedResponse({ items: 'nope' }).flicks).toEqual([]);
  });
});
