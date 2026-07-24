import { buildFlick, KINDS } from '@1nky/protocol';
import { describe, expect, it } from 'vitest';
import { buildUploadAuth, flickInput, flickTemplate, parseUploadResponse } from './flicks.js';

const SERVER_HASH = 'a'.repeat(64);
const CLIENT_HASH = 'b'.repeat(64);

describe('parseUploadResponse', () => {
  it('takes the hash the server returned', () => {
    const result = parseUploadResponse({
      sha256: SERVER_HASH,
      url: 'https://media.example/aaa',
      size: 214_233,
      type: 'image/webp',
    });

    expect(result).toEqual({
      sha256: SERVER_HASH,
      url: 'https://media.example/aaa',
      size: 214_233,
      mime: 'image/webp',
    });
  });

  it('derives a URL when the server omits one', () => {
    const result = parseUploadResponse({ sha256: SERVER_HASH }, 'https://media.example/');
    expect(result.url).toBe(`https://media.example/${SERVER_HASH}`);
  });

  it('lowercases the hash', () => {
    expect(parseUploadResponse({ sha256: SERVER_HASH.toUpperCase() }).sha256).toBe(SERVER_HASH);
  });

  it('refuses a response with no usable address', () => {
    expect(() => parseUploadResponse({ url: 'https://media.example/x' })).toThrow();
    expect(() => parseUploadResponse({ sha256: 'not-a-hash' })).toThrow();
    expect(() => parseUploadResponse(null)).toThrow();
  });

  it('says nothing about protocols in its error copy', () => {
    try {
      parseUploadResponse(null);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message.toLowerCase();
      for (const word of ['hash', 'sha', 'blossom', 'nostr', 'relay']) {
        expect(message).not.toContain(word);
      }
    }
  });
});

describe('flick construction from an upload receipt', () => {
  const upload = parseUploadResponse({
    sha256: SERVER_HASH,
    url: 'https://media.example/aaa',
    size: 300_000,
    type: 'image/webp',
  });
  const dims = { width: 2048, height: 1365 };

  it('uses the server hash, never the client one', () => {
    // The server re-encodes, so the bytes it stored are not the bytes we
    // sent. Its hash is the only address that resolves.
    const input = flickInput(upload, dims, { caption: 'rooftop' });

    expect(input.sha256).toBe(SERVER_HASH);
    expect(input.sha256).not.toBe(CLIENT_HASH);
    expect(input.url).toBe('https://media.example/aaa');
  });

  it('produces a kind-20 with a complete imeta tag', () => {
    const event = flickTemplate(upload, dims, { caption: 'rooftop', alt: 'a rooftop piece' });

    expect(event.kind).toBe(KINDS.FLICK);
    expect(event.content).toBe('rooftop');

    const imeta = event.tags.find((tag) => tag[0] === 'imeta');
    expect(imeta).toBeDefined();
    expect(imeta).toContain('url https://media.example/aaa');
    expect(imeta).toContain(`x ${SERVER_HASH}`);
    expect(imeta).toContain('dim 2048x1365');
    expect(imeta).toContain('m image/webp');
    expect(imeta).toContain('size 300000');
    expect(imeta).toContain('alt a rooftop piece');
  });

  it('mirrors the address into a top-level x tag', () => {
    const event = flickTemplate(upload, dims);
    expect(event.tags).toContainEqual(['x', SERVER_HASH]);
    expect(event.tags).toContainEqual(['m', 'image/webp']);
  });

  it('normalises boards into t tags', () => {
    const event = flickTemplate(upload, dims, { boards: ['SF Bay', '#sf-bay', 'Oakland'] });
    expect(event.tags).toContainEqual(['t', 'sf-bay']);
    expect(event.tags).toContainEqual(['t', 'oakland']);
    expect(event.tags.filter((tag) => tag[0] === 't')).toHaveLength(2);
  });

  it('omits optional fields rather than emitting empties', () => {
    const bare = flickInput({ sha256: SERVER_HASH, url: 'https://media.example/aaa' }, dims);
    expect(bare).not.toHaveProperty('caption');
    expect(bare).not.toHaveProperty('alt');
    expect(bare).not.toHaveProperty('size');
    expect(buildFlick(bare).content).toBe('');
  });
});

describe('upload authorisation', () => {
  it('describes an upload of exactly this blob', () => {
    const auth = buildUploadAuth(SERVER_HASH, 12_345, 1_700_000_000);

    expect(auth.kind).toBe(KINDS.BLOSSOM_AUTH);
    expect(auth.tags).toContainEqual(['t', 'upload']);
    expect(auth.tags).toContainEqual(['x', SERVER_HASH]);
    expect(auth.tags).toContainEqual(['size', '12345']);
  });

  it('expires quickly so a captured header is worthless later', () => {
    const auth = buildUploadAuth(SERVER_HASH, 1, 1_700_000_000);
    const expiration = auth.tags.find((tag) => tag[0] === 'expiration')?.[1];
    expect(Number(expiration)).toBe(1_700_000_300);
  });
});
