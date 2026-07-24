import { describe, expect, it, vi } from 'vitest';

import * as log from './log.js';

function captureStderr(fn: () => void): string {
  let out = '';
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

describe('log.redact', () => {
  it('removes addresses that Node puts in its own error messages', () => {
    expect(log.redact('connect ECONNREFUSED 127.0.0.1:7777')).toBe('connect ECONNREFUSED [address]');
    expect(log.redact('getaddrinfo ENOTFOUND ws://relay.example:7777')).toBe(
      'getaddrinfo ENOTFOUND [address]',
    );
    expect(log.redact('failed at ::1')).toBe('failed at [address]');
  });

  it('leaves ordinary messages alone', () => {
    expect(log.redact('deadlock detected')).toBe('deadlock detected');
    expect(log.redact('migration 001_init.sql failed')).toBe('migration 001_init.sql failed');
  });
});

describe('what the indexer is allowed to say', () => {
  it('writes counts as name=value pairs, skipping zeros', () => {
    const out = captureStderr(() => {
      log.counts('indexed', { events: 3, flicks: 1, errors: 0 });
    });
    expect(out).toBe('indexed events=3 flicks=1\n');
  });

  it('writes a bare label when every count is zero', () => {
    expect(captureStderr(() => log.counts('indexed', { events: 0 }))).toBe('indexed\n');
  });

  it('redacts addresses out of error lines', () => {
    const out = captureStderr(() => {
      log.error('relay', new Error('connect ECONNREFUSED 10.0.0.5:7777'));
    });
    expect(out).toBe('error relay: connect ECONNREFUSED [address]\n');
    expect(out).not.toContain('10.0.0.5');
  });
});
