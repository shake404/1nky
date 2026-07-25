import type { AddressInfo } from 'node:net';
import { once } from 'node:events';

import type { Express } from 'express';

import { loadConfig } from '../config.js';
import type { Queryable, QueryResultLike } from '../types.js';

/** Test-only helpers. Excluded from `tsc` output — see tsconfig.json. */

export const TEST_CONFIG = loadConfig({
  DATABASE_URL: 'postgres://test/test',
  MOD_API_KEY: 'test-mod-key',
} as NodeJS.ProcessEnv);

export function hex(seed: string): string {
  return seed.repeat(Math.ceil(64 / seed.length)).slice(0, 64).toLowerCase();
}

export interface RecordedCall {
  text: string;
  params: readonly unknown[];
}

export interface FakeDb extends Queryable {
  readonly calls: RecordedCall[];
  matching(needle: string): RecordedCall[];
}

export type Responder = (
  text: string,
  params: readonly unknown[],
) => { rows: unknown[]; rowCount?: number | null } | undefined;

/**
 * In-memory stand-in for `pg`. `pnpm test` must never need a live Postgres —
 * CI does not have one.
 */
export function fakeDb(responder?: Responder): FakeDb {
  const calls: RecordedCall[] = [];

  return {
    calls,
    matching(needle: string): RecordedCall[] {
      const lower = needle.toLowerCase();
      return calls.filter((call) => call.text.toLowerCase().includes(lower));
    },
    async query<R>(text: string, params: readonly unknown[] = []): Promise<QueryResultLike<R>> {
      calls.push({ text, params });
      const custom = responder?.(text, params);
      if (custom) {
        return { rows: custom.rows as R[], rowCount: custom.rowCount ?? custom.rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

/** A `pg` stub that fails every query, for the degraded-health path. */
export function brokenDb(message = 'connection refused'): Queryable {
  return {
    query(): Promise<never> {
      return Promise.reject(new Error(message));
    },
  };
}

export interface Fetched {
  status: number;
  headers: Headers;
  body: unknown;
}

/**
 * Boots the app on an ephemeral port and makes a real HTTP request against
 * it, so middleware order, CORS headers and status codes are exercised for
 * real rather than mocked.
 */
export async function request(
  app: Express,
  path: string,
  init?: RequestInit & { method?: string },
): Promise<Fetched> {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init);
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      /* leave as text */
    }
    return { status: response.status, headers: response.headers, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// --- row factories ---------------------------------------------------------

export function flickRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: hex('11'),
    pubkey: hex('ab'),
    created_at: '1700000000',
    url: 'https://cdn.example/a.webp',
    sha256: hex('cd'),
    width: 1024,
    height: 768,
    blurhash: 'LEHV6n',
    caption: 'rooftop',
    boards: ['sf'],
    media_type: 'flick',
    poster_url: null,
    duration: null,
    tag_name: 'SMOG',
    city: 'sf',
    avatar_sha256: null,
    reply_count: 2,
    ...overrides,
  };
}

export function videoRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: hex('22'),
    pubkey: hex('ab'),
    created_at: '1700000200',
    url: 'https://cdn.example/v.mp4',
    sha256: hex('ce'),
    width: 1280,
    height: 720,
    blurhash: 'LEHV6n',
    caption: 'roll-up',
    boards: ['sf'],
    media_type: 'video',
    poster_url: 'https://cdn.example/p.webp',
    duration: 12,
    tag_name: 'SMOG',
    city: 'sf',
    avatar_sha256: null,
    reply_count: 0,
    ...overrides,
  };
}

/** A `boardThreadsQuery` / `searchThreadsQuery` row. */
export function threadSummaryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: hex('55'),
    pubkey: hex('ab'),
    subject: 'Who buffed the Alameda wall?',
    excerpt: 'gone as of this morning',
    created_at: '1700000000',
    expires_at: null,
    happening_at: null,
    reply_count: 3,
    last_reply_at: '1700000900',
    sort_at: '1700000900',
    tag_name: 'SMOG',
    city: 'sf',
    avatar_sha256: null,
    ...overrides,
  };
}

/** A `happeningsQuery` row — a thread summary with a date and its boards. */
export function happeningRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...threadSummaryRow({
      event_id: hex('66'),
      subject: 'Yard jam',
      excerpt: 'bring paint, 2pm at the wall',
      happening_at: '1800000000',
      expires_at: '1800604800',
      last_reply_at: null,
      reply_count: 1,
    }),
    boards: ['oakland', 'happening'],
    ...overrides,
  };
}

/** A `threadQuery` row — the OP with its content. */
export function threadRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: hex('55'),
    pubkey: hex('ab'),
    subject: 'Who buffed the Alameda wall?',
    boards: ['sf', 'oakland'],
    created_at: '1700000000',
    content: 'gone as of this morning, whole panel',
    expires_at: null,
    happening_at: null,
    reply_count: 3,
    last_reply_at: '1700000900',
    tag_name: 'SMOG',
    city: 'sf',
    avatar_sha256: null,
    ...overrides,
  };
}

export function commentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: hex('22'),
    parent_id: hex('11'),
    root_id: hex('11'),
    pubkey: hex('ab'),
    created_at: '1700000100',
    content: 'clean',
    tag_name: 'SMOG',
    avatar_sha256: null,
    ...overrides,
  };
}
