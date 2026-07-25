import { describe, expect, it } from 'vitest';

import {
  buffDelete,
  buffPlan,
  deleteBan,
  DERIVED_TABLES,
  expirationSweep,
  incrementReportCount,
  selectBanList,
  touchPubkeyStats,
  truncateDerived,
  upsertBan,
  upsertBoard,
  upsertEvent,
  upsertThread,
  writeWatermark,
} from './queries.js';
import { hex } from './testing/fixtures.js';

const AUTHOR = hex('ab');
const MOD = hex('7f');
const TARGET = hex('be');

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

  it('defaults to a self-buff — mod power is opt-in, never implicit', () => {
    expect(buffPlan({ pubkey: AUTHOR, targets: [hex('11')] }).mod).toBe(false);
  });

  it('drops the ownership predicate for a moderator takedown only', () => {
    const plan = buffPlan({ pubkey: MOD, targets: [hex('11')] }, true);
    expect(plan.mod).toBe(true);
    const sql = buffDelete(plan);
    expect(sql.text).toContain('delete from events');
    expect(sql.text).not.toContain('pubkey = $2');
    expect(sql.params).toEqual([[hex('11')]]);
  });
});

describe('banned_pubkeys', () => {
  const row = { pubkey: TARGET, reason: 'illegal', banned_at: 1_700_000_000, banned_by: MOD };

  it('binds every value rather than interpolating a pubkey into SQL', () => {
    const sql = upsertBan(row);
    expect(sql.text).not.toContain(TARGET);
    expect(sql.text).not.toContain(MOD);
    expect(sql.params).toEqual([TARGET, 'illegal', 1_700_000_000, MOD]);
  });

  it('refuses to regress to an older mod action (parameterized-replaceable)', () => {
    expect(upsertBan(row).text).toContain('where excluded.banned_at >= banned_pubkeys.banned_at');
  });

  it('scopes an unban so it cannot delete a newer ban', () => {
    const sql = deleteBan(TARGET, 1_700_000_000);
    expect(sql.text).toBe(`delete from banned_pubkeys where pubkey = $1 and banned_at <= $2`);
    expect(sql.params).toEqual([TARGET, 1_700_000_000]);
  });

  it('exports only what the relay can use, in a stable order', () => {
    const sql = selectBanList();
    expect(sql.text).toContain('select pubkey, reason');
    expect(sql.text).toContain('order by pubkey');
    // banned_by is operator provenance and stays in Postgres.
    expect(sql.text).not.toContain('banned_by');
    expect(sql.params).toEqual([]);
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

  it('inserts a thread OP idempotently and binds every value', () => {
    const sql = upsertThread({
      event_id: hex('55'),
      pubkey: AUTHOR,
      subject: 'who buffed it',
      boards: ['sf', 'oakland'],
      created_at: 1_700_000_000,
    });
    expect(sql.text).toContain('insert into threads');
    expect(sql.text).toContain('on conflict (event_id) do nothing');
    expect(sql.text).not.toContain(AUTHOR);
    expect(sql.params).toEqual([hex('55'), AUTHOR, 'who buffed it', ['sf', 'oakland'], 1_700_000_000]);
  });

  it('stores neither the thread content nor its expiry — those live in events', () => {
    const sql = upsertThread({
      event_id: hex('55'),
      pubkey: AUTHOR,
      subject: null,
      boards: [],
      created_at: 1,
    });
    expect(sql.text).not.toContain('content');
    expect(sql.text).not.toContain('expires_at');
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
      'videos',
      'threads',
      'profiles',
      'comments',
      'reports',
      'deletions',
      'boards',
      'crews',
      'crew_badges',
      'pubkey_stats',
      'sync_state',
    ]);
    expect(truncateDerived().text).toContain('truncate table events');
  });

  it('repopulates threads on a rebuild, like every other derived table', () => {
    expect(DERIVED_TABLES).toContain('threads');
    expect(truncateDerived().text).toContain('threads');
  });

  it('never unbans anyone', () => {
    expect(DERIVED_TABLES).not.toContain('banned_pubkeys');
    expect(truncateDerived().text).not.toContain('banned_pubkeys');
  });
});
