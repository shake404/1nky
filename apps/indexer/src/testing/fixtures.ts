import type { SignedEvent } from '@1nky/protocol';

import type { Queryable, QueryResultLike } from '../types.js';

/** Test-only helpers. Excluded from `tsc` output — see tsconfig.json. */

const ZERO = '0'.repeat(64);

/** A plausible signed event. Signatures are not checked by the mappers. */
export function makeEvent(partial: Partial<SignedEvent> = {}): SignedEvent {
  return {
    id: partial.id ?? `a${'1'.repeat(63)}`,
    pubkey: partial.pubkey ?? `b${'2'.repeat(63)}`,
    created_at: partial.created_at ?? 1_700_000_000,
    kind: partial.kind ?? 1,
    tags: partial.tags ?? [],
    content: partial.content ?? '',
    sig: partial.sig ?? ZERO + ZERO,
  } as SignedEvent;
}

/** 64-char lowercase hex made from a short seed, for readable fixtures. */
export function hex(seed: string): string {
  return seed.repeat(Math.ceil(64 / seed.length)).slice(0, 64).toLowerCase();
}

export interface RecordedCall {
  text: string;
  params: readonly unknown[];
}

export interface FakeDb extends Queryable {
  readonly calls: RecordedCall[];
  /** Calls whose SQL contains `needle` (case-insensitive). */
  matching(needle: string): RecordedCall[];
  reset(): void;
}

export type Responder = (
  text: string,
  params: readonly unknown[],
) => QueryResultLike<never> | { rows: unknown[]; rowCount: number | null } | undefined;

/**
 * An in-memory stand-in for `pg`. Records every statement and returns
 * `{ rows: [], rowCount: 1 }` unless `responder` says otherwise.
 */
export function fakeDb(responder?: Responder): FakeDb {
  const calls: RecordedCall[] = [];

  return {
    calls,
    matching(needle: string): RecordedCall[] {
      const lower = needle.toLowerCase();
      return calls.filter((call) => call.text.toLowerCase().includes(lower));
    },
    reset(): void {
      calls.length = 0;
    },
    async query<R>(text: string, params: readonly unknown[] = []): Promise<QueryResultLike<R>> {
      calls.push({ text, params });
      const custom = responder?.(text, params);
      if (custom) return { rows: custom.rows as R[], rowCount: custom.rowCount };
      return { rows: [], rowCount: 1 };
    },
  };
}
