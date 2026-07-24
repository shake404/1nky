import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, nextCursor } from './cursor.js';
import { hex } from './testing/fixtures.js';

const ID = hex('11');

describe('cursor encode/decode', () => {
  it('round-trips', () => {
    const cursor = { createdAt: 1_700_000_000, eventId: ID };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('is url-safe: no +, / or = to escape', () => {
    for (let i = 0; i < 40; i += 1) {
      const encoded = encodeCursor({ createdAt: 1_700_000_000 + i, eventId: hex(String(i % 10)) });
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encodeURIComponent(encoded)).toBe(encoded);
    }
  });

  it('round-trips a zero timestamp', () => {
    expect(decodeCursor(encodeCursor({ createdAt: 0, eventId: ID }))).toEqual({
      createdAt: 0,
      eventId: ID,
    });
  });

  it('rejects junk rather than throwing', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('!!!!')).toBeNull();
    expect(decodeCursor(Buffer.from('nodot').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('.abc').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('123.short').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('abc.' + ID).toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('-1.' + ID).toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('1.5.' + ID).toString('base64url'))).toBeNull();
  });

  it('rejects an uppercase event id, so one row has exactly one cursor', () => {
    expect(decodeCursor(Buffer.from(`1.${'AB'.repeat(32)}`).toString('base64url'))).toBeNull();
  });

  it('rejects an absurdly long cursor without decoding it', () => {
    expect(decodeCursor('a'.repeat(1000))).toBeNull();
  });
});

describe('nextCursor', () => {
  const rows = [
    { created_at: 3, event_id: hex('33') },
    { created_at: 2, event_id: hex('22') },
    { created_at: 1, event_id: hex('11') },
  ];

  it('points at the last row of a full page', () => {
    const cursor = nextCursor(rows, 3);
    expect(cursor).not.toBeNull();
    expect(decodeCursor(cursor as string)).toEqual({ createdAt: 1, eventId: hex('11') });
  });

  it('is null when the page is short — there is nothing after it', () => {
    expect(nextCursor(rows, 24)).toBeNull();
    expect(nextCursor([], 24)).toBeNull();
  });

  it('handles bigint columns arriving as strings', () => {
    const cursor = nextCursor([{ created_at: '1700000000', event_id: hex('11') }], 1);
    expect(decodeCursor(cursor as string)?.createdAt).toBe(1_700_000_000);
  });
});
