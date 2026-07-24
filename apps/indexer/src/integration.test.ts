import { buildBuff, buildFlick, buildProfile, finalizeEvent, generateSecretKey, getPublicKey } from '@1nky/protocol';
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
