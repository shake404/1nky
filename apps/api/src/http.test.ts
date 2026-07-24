import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { encodeCursor } from './cursor.js';
import {
  HttpError,
  oneParam,
  parseCursor,
  parseHexId,
  parseLimit,
  redact,
  secretsMatch,
} from './http.js';
import { hex, TEST_CONFIG } from './testing/fixtures.js';

describe('config', () => {
  it('requires a database', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('defaults the port to 3001', () => {
    expect(loadConfig({ DATABASE_URL: 'x' } as NodeJS.ProcessEnv).port).toBe(3001);
  });

  it('treats a blank MOD_API_KEY as unset rather than as the empty secret', () => {
    expect(loadConfig({ DATABASE_URL: 'x', MOD_API_KEY: '   ' } as NodeJS.ProcessEnv).modApiKey)
      .toBeUndefined();
  });

  it('caps pages at 50', () => {
    expect(TEST_CONFIG.maxLimit).toBe(50);
  });
});

describe('redact', () => {
  it('keeps addresses out of the only line this service ever logs', () => {
    expect(redact('connect ECONNREFUSED 127.0.0.1:5432')).toBe('connect ECONNREFUSED [address]');
    expect(redact('could not reach postgres://user@db.internal:5432/x')).toBe(
      'could not reach [address]',
    );
    expect(redact('relation "flicks" does not exist')).toBe('relation "flicks" does not exist');
  });
});

describe('secretsMatch', () => {
  it('matches only an exact secret', () => {
    expect(secretsMatch('hunter2', 'hunter2')).toBe(true);
    expect(secretsMatch('hunter2', 'hunter3')).toBe(false);
  });

  it('compares secrets of different lengths without throwing', () => {
    expect(secretsMatch('short', 'a-much-longer-secret')).toBe(false);
  });
});

describe('parseLimit', () => {
  it('defaults, caps and validates', () => {
    expect(parseLimit(undefined, TEST_CONFIG)).toBe(TEST_CONFIG.defaultLimit);
    expect(parseLimit('10', TEST_CONFIG)).toBe(10);
    expect(parseLimit('9999', TEST_CONFIG)).toBe(50);
    expect(() => parseLimit('0', TEST_CONFIG)).toThrow(HttpError);
    expect(() => parseLimit('1.5', TEST_CONFIG)).toThrow(HttpError);
    expect(() => parseLimit('abc', TEST_CONFIG)).toThrow(HttpError);
  });

  it('takes the first value when a param is repeated', () => {
    expect(oneParam(['7', '9'])).toBe('7');
    expect(parseLimit(['7', '9'], TEST_CONFIG)).toBe(7);
    expect(oneParam({ nested: 'object' })).toBeUndefined();
  });
});

describe('parseCursor', () => {
  it('accepts a cursor it minted', () => {
    const cursor = { createdAt: 5, eventId: hex('11') };
    expect(parseCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('treats an absent cursor as the first page', () => {
    expect(parseCursor(undefined)).toBeUndefined();
    expect(parseCursor('')).toBeUndefined();
  });

  it('rejects a forged one', () => {
    expect(() => parseCursor('nope')).toThrow(HttpError);
  });
});

describe('parseHexId', () => {
  it('accepts and lowercases a 64-char id', () => {
    expect(parseHexId('AB'.repeat(32), 'id')).toBe(hex('ab'));
  });

  it('rejects anything else', () => {
    expect(() => parseHexId('short', 'id')).toThrow(/64 lowercase hex/);
    expect(() => parseHexId(undefined, 'id')).toThrow(HttpError);
    expect(() => parseHexId('z'.repeat(64), 'id')).toThrow(HttpError);
  });
});
