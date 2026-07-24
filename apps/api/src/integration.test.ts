import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { type ApiConfig, loadConfig } from './config.js';
import { connect, type Database } from './db.js';
import { request } from './testing/fixtures.js';

/**
 * Integration tests against a real Postgres. Skipped unless `PGTEST=1`,
 * because CI has no database.
 *
 *   docker compose -f infra/docker-compose.yml up -d postgres
 *   pnpm --filter @1nky/indexer migrate
 *   PGTEST=1 DATABASE_URL=postgres://oneinky:oneinky@localhost:5432/oneinky \
 *     pnpm --filter @1nky/api test
 *
 * These are what prove the SQL is valid — the unit tests only prove it is the
 * SQL we meant to write.
 */
const enabled = process.env['PGTEST'] === '1';

describe.skipIf(!enabled)('endpoints against a live Postgres', () => {
  let config: ApiConfig;
  let db: Database;
  let app: Express;

  beforeAll(() => {
    config = loadConfig({
      ...process.env,
      MOD_API_KEY: process.env['MOD_API_KEY'] ?? 'pgtest-mod-key',
    });
    db = connect(config.databaseUrl);
    app = createApp(db, config);
  });

  afterAll(async () => {
    if (db) await db.end();
  });

  it('answers healthz', async () => {
    const res = await request(app, '/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: true });
  });

  it.each([
    ['/feed'],
    ['/feed?board=sf&limit=5'],
    ['/boards'],
    ['/search?q=rooftop'],
    [`/writer/${'a'.repeat(64)}`],
    [`/flick/${'a'.repeat(64)}`],
  ])('runs the SQL behind %s', async (path) => {
    const res = await request(app, path);
    // 404 is a valid answer for an id that is not there; 500 is not.
    expect([200, 404]).toContain(res.status);
  });

  it.each([['/mod/queue'], ['/mod/banlist']])('runs the SQL behind %s', async (path) => {
    const res = await request(app, path, {
      headers: { 'X-Mod-Key': config.modApiKey ?? '' },
    });
    expect(res.status).toBe(200);
  });

  it('refuses to write even if asked nicely', async () => {
    const res = await request(app, '/feed', { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
