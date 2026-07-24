import { describe, expect, it } from 'vitest';

import {
  buffDelete,
  buffPlan,
  DERIVED_TABLES,
  expirationSweep,
  incrementReportCount,
  touchPubkeyStats,
  truncateDerived,
  upsertBoard,
  upsertEvent,
  writeWatermark,
} from './queries.js';
import { hex } from './testing/fixtures.js';

const AUTHOR = hex('ab');

describe('buff (kind 5) deletion logic', () => {
  it('keeps only well-formed event ids and counts the rest', () => {
    const plan = buffPlan({
      pubkey: AUTHOR,
      targets: [hex('11'), 'nope', hex('11'), 'ABC', hex('22')],
    });
    expect(plan.targets).toEqual([hex('11'), hex('22')]);
    expect(plan.rejected).toBe(2);
    expect(plan.pubkey).toBe(AUTHOR);
  });

  it('rejects uppercase hex — ids are lowercase by protocol', () => {
    expect(buffPlan({ pubkey: AUTHOR, targets: ['AB'.repeat(32)] }).targets).toEqual([]);
  });

  it('scopes the delete to the signer, so nobody can buff another writer', () => {
    const plan = buffPlan({ pubkey: AUTHOR, targets: [hex('11')] });
    const sql = buffDelete(plan);
    expect(sql.text).toContain('and pubkey = $2');
    expect(sql.params).toEqual([[hex('11')], AUTHOR]);
    // The ownership check is in SQL, not in JS: no read-then-write race.
    expect(sql.text.toLowerCase()).not.toContain('select');
  });

  it('relies on cascade rather than deleting each derived table by hand', () => {
    const sql = buffDelete(buffPlan({ pubkey: AUTHOR, targets: [hex('11')] }));
    expect(sql.text).toContain('delete from events');
    expect(sql.text).not.toContain('flicks');
  });
});

describe('expiration sweep query', () => {
  it('only touches rows that can expire, and only past ones', () => {
    const sql = expirationSweep(1_700_000_000);
    expect(sql.text).toContain('expires_at is not null');
    expect(sql.text).toContain('expires_at <= $1');
    expect(sql.params).toEqual([1_700_000_000]);
  });

  it('binds the clock rather than interpolating it', () => {
    expect(expirationSweep(42).text).not.toContain('42');
    expect(expirationSweep(42).text).not.toContain('now()');
  });
});

describe('watermark', () => {
  it('never moves backwards', () => {
    const sql = writeWatermark(123);
    expect(sql.text).toContain('greatest(sync_state.last_created_at, excluded.last_created_at)');
    expect(sql.params).toEqual(['relay', 123]);
  });
});

describe('upserts', () => {
  it('inserts events idempotently', () => {
    const sql = upsertEvent({
      id: hex('11'),
      pubkey: AUTHOR,
      kind: 20,
      created_at: 1,
      content: '',
      tags: '[]',
      raw: '{}',
      expires_at: null,
    });
    expect(sql.text).toContain('on conflict (id) do nothing');
    expect(sql.params).toHaveLength(8);
  });

  it('bumps event_count for the author and report_count for the target', () => {
    expect(touchPubkeyStats(AUTHOR, 1).text).toContain('event_count    = pubkey_stats.event_count + 1');
    expect(incrementReportCount(AUTHOR, 1).text).toContain(
      'report_count   = pubkey_stats.report_count + 1',
    );
  });

  it('lets the signed registry set a title but never a discovered board', () => {
    const row = { slug: 'sf', title: 'San Francisco', kind: 'city', created_by: null, created_at: 1 };
    expect(upsertBoard(row, 'registry').text).toContain('title = excluded.title');
    expect(upsertBoard(row, 'discovered').text).not.toContain('title = excluded.title');
  });
});

describe('rebuild', () => {
  it('truncates everything derived from the relay', () => {
    expect([...DERIVED_TABLES]).toEqual([
      'events',
      'flicks',
      'profiles',
      'comments',
      'reports',
      'deletions',
      'boards',
      'pubkey_stats',
      'sync_state',
    ]);
    expect(truncateDerived().text).toContain('truncate table events');
  });

  it('never unbans anyone', () => {
    expect(DERIVED_TABLES).not.toContain('banned_pubkeys');
    expect(truncateDerived().text).not.toContain('banned_pubkeys');
  });
});
