import { buildBuff, buildFlick, buildModBan, buildProfile, finalizeEvent, generateSecretKey, getPublicKey } from '@1nky/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect, type Database } from './db.js';
import { migrate } from './migrate.js';
import { indexEvent, newCounters, sweepExpired, truncateDerived } from './store.js';

/**
 * Integration tests against a real Postgres.
 *
 * CI has no database, so these are skipped unless `PGTEST=1`. Run them with:
 *
 *   docker compose -f infra/docker-compose.yml up -d postgres
 *   PGTEST=1 DATABASE_URL=postgres://oneinky:oneinky@localhost:5432/oneinky \
 *     pnpm --filter @1nky/indexer test
 *
 * They are the only place the generated tsvector column, the cascade
 * behaviour and the row-comparison keyset are actually executed.
 */
const enabled = process.env['PGTEST'] === '1';
const DATABASE_URL = process.env['DATABASE_URL'] ?? '';

describe.skipIf(!enabled)('schema against a live Postgres', () => {
  let db: Database;
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const now = Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    db = connect(DATABASE_URL);
    await migrate(db);
    await truncateDerived(db);
  });

  afterAll(async () => {
    if (db) await db.end();
  });

  it('has no column that could identify a client', async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type
         from information_schema.columns
        where table_schema = 'public'`,
    );
    expect(rows.length).toBeGreaterThan(0);

    const offenders = rows.filter(
      (row) =>
        /(^|_)(ip|inet|addr|useragent|user_agent|session)/i.test(row.column_name) ||
        /^(inet|cidr|macaddr|macaddr8)$/i.test(row.data_type),
    );
    expect(offenders).toEqual([]);
  });

  it('leaves not one row behind for a gift wrap', async () => {
    const counters = newCounters();
    const before = await db.query<{ n: string }>('select count(*)::text as n from events');

    const wrap = finalizeEvent(
      {
        kind: 1059,
        created_at: now - 4000,
        tags: [['p', 'e'.repeat(64)]],
        content: 'AsK0KGvfrmHy',
      },
      generateSecretKey(),
    );
    await indexEvent(db, wrap, counters, { now });

    expect(counters.skipped).toBe(1);
    const after = await db.query<{ n: string }>('select count(*)::text as n from events');
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);

    const anywhere = await db.query('select 1 from events where kind = 1059');
    expect(anywhere.rows).toEqual([]);
    const stats = await db.query('select 1 from pubkey_stats where pubkey = $1', [wrap.pubkey]);
    expect(stats.rows).toEqual([]);
  });

  it('stores a writer bio in profiles.about', async () => {
    const counters = newCounters();
    const profile = finalizeEvent(
      buildProfile({ tag: 'SMOG', city: 'sf', bio: 'panels and rooftops' }),
      sk,
    );
    await indexEvent(db, profile, counters, { now });

    const { rows } = await db.query<{ about: string | null }>(
      'select about from profiles where pubkey = $1',
      [pubkey],
    );
    expect(rows[0]?.about).toBe('panels and rooftops');
  });

  it('stores a flick and finds it by full-text search', async () => {
    const counters = newCounters();
    const profile = finalizeEvent(buildProfile({ tag: 'SMOG', city: 'sf' }), sk);
    const flick = finalizeEvent(
      buildFlick({
        url: 'https://cdn.example/a.webp',
        sha256: 'c'.repeat(64),
        dims: { width: 10, height: 20 },
        caption: 'a clean rooftop burner',
        boards: ['sf'],
      }),
      sk,
    );

    await indexEvent(db, profile, counters, { now });
    await indexEvent(db, flick, counters, { now });

    const found = await db.query<{ event_id: string }>(
      `select f.event_id from flicks f
         join events e on e.id = f.event_id
        where e.content_tsv @@ websearch_to_tsquery('english', $1)`,
      ['rooftop'],
    );
    expect(found.rows.map((r) => r.event_id)).toContain(flick.id);
  });

  it('buffs a flick and cascades it out of every derived table', async () => {
    const counters = newCounters();
    const flick = finalizeEvent(
      buildFlick({
        url: 'https://cdn.example/b.webp',
        sha256: 'd'.repeat(64),
        dims: { width: 10, height: 20 },
        caption: 'buff me',
      }),
      sk,
    );
    await indexEvent(db, flick, counters, { now });

    const buff = finalizeEvent(buildBuff([flick.id], { kinds: [20] }), sk);
    await indexEvent(db, buff, counters, { now });

    const events = await db.query(`select id from events where id = $1`, [flick.id]);
    const flicks = await db.query(`select event_id from flicks where event_id = $1`, [flick.id]);
    expect(events.rows).toHaveLength(0);
    expect(flicks.rows).toHaveLength(0);
  });

  it('cannot buff another writer content', async () => {
    const counters = newCounters();
    const otherSk = generateSecretKey();
    const victim = finalizeEvent(
      buildFlick({
        url: 'https://cdn.example/c.webp',
        sha256: 'e'.repeat(64),
        dims: { width: 10, height: 20 },
      }),
      otherSk,
    );
    await indexEvent(db, victim, counters, { now });

    const forged = finalizeEvent(buildBuff([victim.id], {}), sk);
    await indexEvent(db, forged, counters, { now });

    const events = await db.query(`select id from events where id = $1`, [victim.id]);
    expect(events.rows).toHaveLength(1);
  });

  /**
   * The moderation guards live in SQL — an `on conflict ... where` and a scoped
   * `delete` — precisely so a forged or out-of-order action cannot win a race
   * against a read-then-write. A fake db cannot check either, so this is the
   * only place they actually execute.
   */
  it('applies, refuses to regress, and lifts a moderator ban', async () => {
    const counters = newCounters();
    const modSk = generateSecretKey();
    const mod = getPublicKey(modSk);
    const mods: ReadonlySet<string> = new Set([mod]);
    const target = 'b'.repeat(64);
    const options = { now, modPubkeys: mods };

    const banAt = async (createdAt: number, reason: string) =>
      indexEvent(
        db,
        finalizeEvent(buildModBan(target, 'ban', { reason, createdAt }), modSk),
        counters,
        options,
      );
    const row = async () =>
      (
        await db.query<{ reason: string | null; banned_at: string; banned_by: string }>(
          'select reason, banned_at::text, banned_by from banned_pubkeys where pubkey = $1',
          [target],
        )
      ).rows[0];

    await db.query('delete from banned_pubkeys where pubkey = $1', [target]);

    await banAt(now - 100, 'illegal');
    expect((await row())?.reason).toBe('illegal');
    expect((await row())?.banned_by).toBe(mod);

    // A newer action wins.
    await banAt(now - 10, 'spam');
    expect((await row())?.reason).toBe('spam');

    // An older one does not: no regression on a replayed firehose overlap.
    await banAt(now - 50, 'stale');
    expect((await row())?.reason).toBe('spam');

    // Neither does an unban signed before the ban in force.
    await indexEvent(
      db,
      finalizeEvent(buildModBan(target, 'unban', { createdAt: now - 50 }), modSk),
      counters,
      options,
    );
    expect(await row()).toBeDefined();

    // A current unban lifts it.
    await indexEvent(
      db,
      finalizeEvent(buildModBan(target, 'unban', { createdAt: now }), modSk),
      counters,
      options,
    );
    expect(await row()).toBeUndefined();
  });

  it('ignores a ban from a pubkey that is not a moderator', async () => {
    const counters = newCounters();
    const target = 'c'.repeat(64);
    await db.query('delete from banned_pubkeys where pubkey = $1', [target]);

    await indexEvent(
      db,
      finalizeEvent(buildModBan(target, 'ban', { reason: 'illegal', createdAt: now }), sk),
      counters,
      { now, modPubkeys: new Set([getPublicKey(generateSecretKey())]) },
    );

    const { rows } = await db.query('select 1 from banned_pubkeys where pubkey = $1', [target]);
    expect(rows).toHaveLength(0);
  });

  it('keeps bans through a rebuild', async () => {
    const target = 'd'.repeat(64);
    await db.query(
      `insert into banned_pubkeys (pubkey, reason, banned_at, banned_by)
       values ($1, 'illegal', $2, $3) on conflict (pubkey) do nothing`,
      [target, now, getPublicKey(sk)],
    );

    await truncateDerived(db);

    const { rows } = await db.query('select 1 from banned_pubkeys where pubkey = $1', [target]);
    expect(rows).toHaveLength(1);
    await db.query('delete from banned_pubkeys where pubkey = $1', [target]);
  });

  it('lets a moderator take down another writer event, and nobody else', async () => {
    const counters = newCounters();
    const modSk = generateSecretKey();
    const mods: ReadonlySet<string> = new Set([getPublicKey(modSk)]);

    const victim = finalizeEvent(
      buildFlick({
        url: 'https://cdn.example/mod.webp',
        sha256: '9'.repeat(64),
        dims: { width: 10, height: 20 },
      }),
      generateSecretKey(),
    );
    await indexEvent(db, victim, counters, { now });

    // A stranger cannot.
    await indexEvent(db, finalizeEvent(buildBuff([victim.id], {}), sk), counters, {
      now,
      modPubkeys: mods,
    });
    expect((await db.query('select 1 from events where id = $1', [victim.id])).rows).toHaveLength(1);

    // A moderator can.
    await indexEvent(db, finalizeEvent(buildBuff([victim.id], {}), modSk), counters, {
      now,
      modPubkeys: mods,
    });
    expect((await db.query('select 1 from events where id = $1', [victim.id])).rows).toHaveLength(0);
  });

  it('sweeps expired events (NIP-40)', async () => {
    const counters = newCounters();
    const doomed = finalizeEvent(
      buildFlick({
        url: 'https://cdn.example/d.webp',
        sha256: 'f'.repeat(64),
        dims: { width: 10, height: 20 },
        expiration: now + 60,
      }),
      sk,
    );
    await indexEvent(db, doomed, counters, { now });

    expect(await sweepExpired(db, now)).toBe(0);
    expect(await sweepExpired(db, now + 61)).toBeGreaterThanOrEqual(1);

    const events = await db.query(`select id from events where id = $1`, [doomed.id]);
    expect(events.rows).toHaveLength(0);
  });
});
