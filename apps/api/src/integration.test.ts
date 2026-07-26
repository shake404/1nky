import type { Express } from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { type ApiConfig, loadConfig } from './config.js';
import { connect, type Database } from './db.js';
import { hex, request } from './testing/fixtures.js';

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
    ['/boards?kind=city'],
    ['/board/sf'],
    ['/board/sf?limit=5'],
    ['/explore'],
    ['/explore/facets'],
    ['/search?q=rooftop'],
    ['/happenings'],
    ['/happenings?city=sf&limit=5'],
    [`/writer/${'a'.repeat(64)}`],
    [`/mentions/${'a'.repeat(64)}`],
    [`/mentions/${'a'.repeat(64)}?limit=5`],
    [`/flick/${'a'.repeat(64)}`],
    [`/thread/${'a'.repeat(64)}`],
    [`/crew/${'a'.repeat(64)}`],
  ])('runs the SQL behind %s', async (path) => {
    const res = await request(app, path);
    // 404 is a valid answer for an id that is not there; 500 is not.
    expect([200, 404]).toContain(res.status);
  });

  it.each([
    ['/mod/queue'],
    ['/mod/banlist'],
    ['/mod/tree'],
    [`/mod/tree/${'a'.repeat(64)}`],
  ])('runs the SQL behind %s', async (path) => {
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

/**
 * NIP-40 at read time, end to end.
 *
 * The unit tests prove the predicate is in the SQL; only this proves it does
 * what it is for. Two thread OPs are seeded directly — one permanent, one whose
 * expiry passed an hour ago and which NO sweep has run on — and the endpoints
 * are asked through real HTTP whether they can still see the expired one. They
 * must not: a beef that says it lasts 24h has to be gone at 24h, not at 24h
 * plus however long until the next sweep.
 *
 * The app's own pool is read-only by design, so seeding uses a separate pool.
 */
describe.skipIf(!enabled)('expired rows are hidden before the sweep reaches them', () => {
  let config: ApiConfig;
  let db: Database;
  let app: Express;
  let seed: pg.Pool;

  const WRITER = hex('a1');
  const LIVE = hex('b1');
  const DOOMED = hex('b2');
  const REPLY = hex('b3');
  const BOARD = 'pgtest-expiry';
  const now = Math.floor(Date.now() / 1000);

  const insertEvent = async (id: string, kind: number, content: string, expiresAt: number | null) => {
    await seed.query(
      `insert into events (id, pubkey, kind, created_at, content, tags, raw, expires_at)
       values ($1, $2, $3, $4, $5, '[]'::jsonb, '{}'::jsonb, $6)
       on conflict (id) do nothing`,
      [id, WRITER, kind, now - 600, content, expiresAt],
    );
  };

  beforeAll(async () => {
    config = loadConfig({
      ...process.env,
      MOD_API_KEY: process.env['MOD_API_KEY'] ?? 'pgtest-mod-key',
    });
    db = connect(config.databaseUrl);
    app = createApp(db, config);
    seed = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });

    for (const id of [LIVE, DOOMED, REPLY]) {
      await seed.query('delete from events where id = $1', [id]);
    }

    // Permanent thread, and a beef whose 24h ran out an hour ago.
    await insertEvent(LIVE, 1, 'still standing', null);
    await insertEvent(DOOMED, 1, 'gone by now', now - 3600);
    // A reply on the live thread that has itself expired.
    await insertEvent(REPLY, 1111, 'stale reply', now - 3600);

    for (const [id, board] of [
      [LIVE, BOARD],
      [DOOMED, BOARD],
    ] as const) {
      await seed.query(
        `insert into threads (event_id, pubkey, subject, boards, created_at)
         values ($1, $2, $3, array[$4]::text[], $5)
         on conflict (event_id) do nothing`,
        [id, WRITER, id === LIVE ? 'live thread' : 'expired beef', board, now - 600],
      );
    }
    await seed.query(
      `insert into comments (event_id, parent_id, root_id, pubkey, created_at, content)
       values ($1, $2, $2, $3, $4, 'stale reply') on conflict (event_id) do nothing`,
      [REPLY, LIVE, WRITER, now - 300],
    );
  });

  afterAll(async () => {
    if (seed) {
      for (const id of [LIVE, DOOMED, REPLY]) {
        await seed.query('delete from events where id = $1', [id]);
      }
      await seed.end();
    }
    if (db) await db.end();
  });

  it('lists the live thread on the board and not the expired one', async () => {
    const res = await request(app, `/board/${BOARD}`);
    expect(res.status).toBe(200);
    const body = res.body as { threads: { id: string; subject: string }[] };
    const ids = body.threads.map((t) => t.id);
    expect(ids).toContain(LIVE);
    expect(ids).not.toContain(DOOMED);
  });

  it('serves the live thread and 404s the expired one', async () => {
    expect((await request(app, `/thread/${LIVE}`)).status).toBe(200);
    expect((await request(app, `/thread/${DOOMED}`)).status).toBe(404);
  });

  it('leaves an expired reply out of the thread and out of its reply count', async () => {
    const res = await request(app, `/thread/${LIVE}`);
    const body = res.body as { thread: { replyCount: number }; comments: unknown[] };
    expect(body.comments).toEqual([]);
    expect(body.thread.replyCount).toBe(0);
  });

  it('counts only the live thread in the board thread count', async () => {
    const res = await request(app, '/boards');
    const board = (res.body as { boards: { slug: string; threadCount: number }[] }).boards.find(
      (b) => b.slug === BOARD,
    );
    // The board row itself only exists if the indexer registered it; when it
    // does, the count must be 1, never 2.
    if (board) expect(board.threadCount).toBe(1);
  });

  it('does not surface an expired thread through search either', async () => {
    const res = await request(app, '/search?q=gone');
    const ids = (res.body as { threads: { id: string }[] }).threads.map((t) => t.id);
    expect(ids).not.toContain(DOOMED);
  });
});

/**
 * Happenings, end to end.
 *
 * The unit tests prove the ordering, the city filter and the 7-day window are in
 * the SQL; only this proves Postgres agrees. Four dated threads are seeded — one
 * soon, one later, one that happened three weeks ago (still un-swept, with no
 * NIP-40 expiry at all, which is the case the defensive window exists for) and
 * one in a different city — plus one ordinary undated thread that must not
 * appear at all.
 */
describe.skipIf(!enabled)('happenings against a live Postgres', () => {
  let config: ApiConfig;
  let db: Database;
  let app: Express;
  let seed: pg.Pool;

  const WRITER = hex('a2');
  const SOON = hex('c1');
  const LATER = hex('c2');
  const STALE = hex('c3');
  const ELSEWHERE = hex('c4');
  const UNDATED = hex('c5');
  const CITY = 'pgtest-happenings';
  const OTHER_CITY = 'pgtest-elsewhere';
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86_400;

  const ALL_IDS = [SOON, LATER, STALE, ELSEWHERE, UNDATED];

  const seedThread = async (
    id: string,
    city: string,
    happeningAt: number | null,
    subject: string,
  ) => {
    await seed.query(
      `insert into events (id, pubkey, kind, created_at, content, tags, raw, expires_at)
       values ($1, $2, 1, $3, $4, '[]'::jsonb, '{}'::jsonb, null)
       on conflict (id) do nothing`,
      [id, WRITER, now - 600, `${subject} — bring paint`],
    );
    const boards = happeningAt === null ? [city] : [city, 'happening'];
    await seed.query(
      `insert into threads (event_id, pubkey, subject, boards, created_at, happening_at)
       values ($1, $2, $3, $4::text[], $5, $6)
       on conflict (event_id) do nothing`,
      [id, WRITER, subject, boards, now - 600, happeningAt],
    );
  };

  beforeAll(async () => {
    config = loadConfig({
      ...process.env,
      MOD_API_KEY: process.env['MOD_API_KEY'] ?? 'pgtest-mod-key',
    });
    db = connect(config.databaseUrl);
    app = createApp(db, config);
    seed = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });

    for (const id of ALL_IDS) await seed.query('delete from events where id = $1', [id]);

    await seedThread(LATER, CITY, now + 10 * DAY, 'later jam');
    await seedThread(SOON, CITY, now + DAY, 'tomorrow jam');
    // Three weeks past, and deliberately with NO expiry: nothing but the
    // query's own 7-day window can keep this off the list.
    await seedThread(STALE, CITY, now - 21 * DAY, 'long gone jam');
    await seedThread(ELSEWHERE, OTHER_CITY, now + 2 * DAY, 'other town jam');
    await seedThread(UNDATED, CITY, null, 'just a thread');
  });

  afterAll(async () => {
    if (seed) {
      for (const id of ALL_IDS) await seed.query('delete from events where id = $1', [id]);
      await seed.end();
    }
    if (db) await db.end();
  });

  const idsOf = (body: unknown): string[] =>
    (body as { happenings: { id: string }[] }).happenings.map((h) => h.id);

  it('lists upcoming happenings soonest first', async () => {
    const res = await request(app, `/happenings?city=${CITY}`);
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual([SOON, LATER]);
  });

  it('excludes an undated thread — a happening is a thread WITH a date', async () => {
    const res = await request(app, `/happenings?city=${CITY}`);
    expect(idsOf(res.body)).not.toContain(UNDATED);
  });

  it('excludes one that happened more than seven days ago, un-swept and unexpiring', async () => {
    const res = await request(app, `/happenings?city=${CITY}`);
    expect(idsOf(res.body)).not.toContain(STALE);
  });

  it('filters by city', async () => {
    const mine = await request(app, `/happenings?city=${CITY}`);
    expect(idsOf(mine.body)).not.toContain(ELSEWHERE);
    const theirs = await request(app, `/happenings?city=${OTHER_CITY}`);
    expect(idsOf(theirs.body)).toEqual([ELSEWHERE]);
  });

  it('pages forwards on the date without repeating a row', async () => {
    const first = await request(app, `/happenings?city=${CITY}&limit=1`);
    expect(idsOf(first.body)).toEqual([SOON]);
    const cursor = (first.body as { nextCursor: string | null }).nextCursor;
    expect(cursor).toBeTypeOf('string');

    const second = await request(app, `/happenings?city=${CITY}&limit=1&cursor=${cursor ?? ''}`);
    expect(idsOf(second.body)).toEqual([LATER]);
  });

  it('carries the date, the boards and the writer', async () => {
    const res = await request(app, `/happenings?city=${CITY}&limit=1`);
    const happening = (res.body as {
      happenings: { happeningAt: number; boards: string[]; writer: { pubkey: string } }[];
    }).happenings[0];
    expect(happening?.happeningAt).toBe(now + DAY);
    expect(happening?.boards).toContain(CITY);
    expect(happening?.boards).toContain('happening');
    expect(happening?.writer.pubkey).toBe(WRITER);
  });

  it('reports the date on the thread detail too', async () => {
    const res = await request(app, `/thread/${SOON}`);
    expect(res.status).toBe(200);
    expect((res.body as { thread: { happeningAt: number } }).thread.happeningAt).toBe(now + DAY);
  });

  it('reports null on an undated thread detail', async () => {
    const res = await request(app, `/thread/${UNDATED}`);
    expect((res.body as { thread: { happeningAt: number | null } }).thread.happeningAt).toBeNull();
  });
});

/**
 * The invite forest, end to end.
 *
 * A three-level branch is seeded straight into `invite_edges` and the real
 * endpoints are asked about it over HTTP. This is what proves the recursive CTE
 * and the two-query assembly agree — and that `putOn` leaks nothing else.
 */
describe.skipIf(!enabled)('the invite tree over real HTTP', () => {
  let config: ApiConfig;
  let db: Database;
  let app: Express;
  let seed: pg.Pool;

  const ROOT = hex('c1');
  const MIDDLE = hex('c2');
  const LEAF = hex('c3');
  const ALL = [ROOT, MIDDLE, LEAF];
  const now = Math.floor(Date.now() / 1000);

  interface Node {
    pubkey: string;
    tag: string | null;
    invitedAt: number | null;
    banned: boolean;
    eventCount: number;
    reportCount: number;
    children: Node[];
  }

  beforeAll(async () => {
    config = loadConfig({
      ...process.env,
      MOD_API_KEY: process.env['MOD_API_KEY'] ?? 'pgtest-mod-key',
    });
    db = connect(config.databaseUrl);
    app = createApp(db, config);
    seed = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });

    await seed.query('delete from invite_edges where child = any($1::text[])', [ALL]);
    await seed.query('delete from profiles where pubkey = any($1::text[])', [ALL]);
    await seed.query('delete from pubkey_stats where pubkey = any($1::text[])', [ALL]);

    for (const [child, parent, at] of [
      [MIDDLE, ROOT, now - 200],
      [LEAF, MIDDLE, now - 100],
    ] as const) {
      await seed.query(
        `insert into invite_edges (child, parent, invite_id, redeemed_at)
         values ($1, $2, $3, $4) on conflict (child) do nothing`,
        [child, parent, 'ab12cd34ef567890', at],
      );
    }
    await seed.query(
      `insert into profiles (pubkey, tag_name, first_seen, updated_at)
       values ($1, 'MIDDLE', $2, $2) on conflict (pubkey) do nothing`,
      [MIDDLE, now - 200],
    );
    await seed.query(
      `insert into pubkey_stats (pubkey, first_event_at, event_count, report_count)
       values ($1, $2, 7, 2) on conflict (pubkey) do nothing`,
      [MIDDLE, now - 200],
    );
  });

  afterAll(async () => {
    if (seed) {
      await seed.query('delete from invite_edges where child = any($1::text[])', [ALL]);
      await seed.query('delete from profiles where pubkey = any($1::text[])', [ALL]);
      await seed.query('delete from pubkey_stats where pubkey = any($1::text[])', [ALL]);
      await seed.end();
    }
    if (db) await db.end();
  });

  const findNode = (nodes: readonly Node[], pubkey: string): Node | undefined => {
    for (const node of nodes) {
      if (node.pubkey === pubkey) return node;
      const found = findNode(node.children, pubkey);
      if (found) return found;
    }
    return undefined;
  };

  it('nests the seeded branch under its root in GET /mod/tree', async () => {
    const res = await request(app, '/mod/tree', {
      headers: { 'X-Mod-Key': config.modApiKey ?? '' },
    });
    expect(res.status).toBe(200);
    const body = res.body as { roots: Node[]; truncated: boolean };

    const root = body.roots.find((r) => r.pubkey === ROOT);
    expect(root).toBeDefined();
    expect(root?.invitedAt).toBeNull();

    const middle = findNode(body.roots, MIDDLE);
    expect(middle?.tag).toBe('MIDDLE');
    expect(middle?.invitedAt).toBe(now - 200);
    expect(middle?.eventCount).toBe(7);
    expect(middle?.reportCount).toBe(2);
    expect(middle?.children.map((c) => c.pubkey)).toEqual([LEAF]);
  });

  it('walks only downward for GET /mod/tree/:pubkey', async () => {
    const res = await request(app, `/mod/tree/${MIDDLE}`, {
      headers: { 'X-Mod-Key': config.modApiKey ?? '' },
    });
    expect(res.status).toBe(200);
    const body = res.body as { roots: Node[]; truncated: boolean };

    expect(body.roots.map((r) => r.pubkey)).toEqual([MIDDLE]);
    expect(body.roots[0]?.invitedAt).toBe(now - 200);
    expect(body.roots[0]?.children.map((c) => c.pubkey)).toEqual([LEAF]);
    // The root that put MIDDLE on is not in a downward walk.
    expect(findNode(body.roots, ROOT)).toBeUndefined();
    expect(body.truncated).toBe(false);
  });

  it('reports a lone root for a writer nobody put on', async () => {
    const stranger = hex('c9');
    const res = await request(app, `/mod/tree/${stranger}`, {
      headers: { 'X-Mod-Key': config.modApiKey ?? '' },
    });
    expect(res.status).toBe(200);
    const body = res.body as { roots: Node[] };
    expect(body.roots).toHaveLength(1);
    expect(body.roots[0]?.pubkey).toBe(stranger);
    expect(body.roots[0]?.invitedAt).toBeNull();
    expect(body.roots[0]?.children).toEqual([]);
  });

  it('exposes putOn publicly and the rest of the tree not at all', async () => {
    const res = await request(app, `/writer/${MIDDLE}`);
    expect(res.status).toBe(200);
    const writer = (res.body as { writer: Record<string, unknown> }).writer;
    expect(writer.putOn).toBe(true);
    const json = JSON.stringify(writer);
    expect(json).not.toContain(ROOT);
    expect(json).not.toContain('invitedAt');
  });

  it('needs the mod key for the tree, even though putOn is public', async () => {
    expect((await request(app, '/mod/tree')).status).toBe(401);
    expect((await request(app, `/mod/tree/${MIDDLE}`)).status).toBe(401);
  });
});

/**
 * Amendments ("Add to this"), end to end.
 *
 * The API is read-only and has no amendment endpoint, and that is the claim
 * under test: the indexer merges an amendment into the read model, so the
 * ordinary reads — the flick, the board it was added to, the shout-outs inbox —
 * report the amended state with no new route and no client change.
 *
 * Seeded the way the indexer would leave it: a flick whose `boards` array has
 * already had the added wall merged in, plus a `mentions` row whose naming event
 * is the amendment (kind 1113) rather than a comment. That second half is the
 * part the mentions read had to learn — an amendment has no `comments` row.
 */
describe.skipIf(!enabled)('amended posts read back through the ordinary endpoints', () => {
  let config: ApiConfig;
  let db: Database;
  let app: Express;
  let seed: pg.Pool;

  const WRITER = hex('a5');
  const NAMED = hex('a6');
  const FLICK = hex('e1');
  const AMENDMENT = hex('e2');
  const ADDED_BOARD = 'pgtest-added-wall';
  const now = Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    config = loadConfig({
      ...process.env,
      MOD_API_KEY: process.env['MOD_API_KEY'] ?? 'pgtest-mod-key',
    });
    db = connect(config.databaseUrl);
    app = createApp(db, config);
    seed = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });

    for (const id of [FLICK, AMENDMENT]) {
      await seed.query('delete from events where id = $1', [id]);
    }

    await seed.query(
      `insert into events (id, pubkey, kind, created_at, content, tags, raw, expires_at)
       values ($1, $2, 20, $3, 'rooftop panel', '[]'::jsonb, '{}'::jsonb, null)
       on conflict (id) do nothing`,
      [FLICK, WRITER, now - 600],
    );
    // The amendment itself: kind 1113, no content — an amendment is tags.
    await seed.query(
      `insert into events (id, pubkey, kind, created_at, content, tags, raw, expires_at)
       values ($1, $2, 1113, $3, '', '[]'::jsonb, '{}'::jsonb, null)
       on conflict (id) do nothing`,
      [AMENDMENT, WRITER, now - 300],
    );
    // `boards` as the merge leaves it: the original wall plus the added one.
    await seed.query(
      `insert into flicks (event_id, pubkey, created_at, url, sha256, width, height, blurhash, caption, boards)
       values ($1, $2, $3, 'https://cdn.example/e1.webp', $4, 100, 200, null, 'rooftop panel',
               array['pgtest-original-wall', $5]::text[])
       on conflict (event_id) do update set boards = excluded.boards`,
      [FLICK, WRITER, now - 600, 'e1'.repeat(32), ADDED_BOARD],
    );
    await seed.query(
      `insert into boards (slug, title, kind, created_by, created_at)
       values ($1, $1, 'city', null, $2) on conflict (slug) do nothing`,
      [ADDED_BOARD, now - 300],
    );
    await seed.query(
      `insert into mentions (event_id, mentioned_pubkey, author_pubkey, root_id, created_at)
       values ($1, $2, $3, $4, $5) on conflict (event_id, mentioned_pubkey) do nothing`,
      [AMENDMENT, NAMED, WRITER, FLICK, now - 300],
    );
  });

  afterAll(async () => {
    if (seed) {
      for (const id of [FLICK, AMENDMENT]) {
        await seed.query('delete from events where id = $1', [id]);
      }
      await seed.query('delete from boards where slug = $1', [ADDED_BOARD]);
      await seed.end();
    }
    if (db) await db.end();
  });

  it('reports the added wall on the flick itself', async () => {
    const res = await request(app, `/flick/${FLICK}`);
    expect(res.status).toBe(200);
    const flick = (res.body as { flick: { boards: string[] } }).flick;
    expect(flick.boards).toContain('pgtest-original-wall');
    expect(flick.boards).toContain(ADDED_BOARD);
  });

  it('puts the flick on the wall it was added to, and in the feed for it', async () => {
    const board = await request(app, `/feed?board=${ADDED_BOARD}`);
    expect(board.status).toBe(200);
    const ids = (board.body as { flicks: { id: string }[] }).flicks.map((f) => f.id);
    expect(ids).toContain(FLICK);

    // And through Explore, which filters on the same array.
    const explore = await request(app, `/explore?city=${ADDED_BOARD}`);
    expect((explore.body as { flicks: { id: string }[] }).flicks.map((f) => f.id)).toContain(FLICK);
  });

  it('counts the flick on the board it was added to', async () => {
    const res = await request(app, '/boards');
    const board = (res.body as { boards: { slug: string; flickCount: number }[] }).boards.find(
      (b) => b.slug === ADDED_BOARD,
    );
    expect(board?.flickCount).toBe(1);
  });

  it('lands a tag in the named writer shout-outs, with a door to the flick', async () => {
    const res = await request(app, `/mentions/${NAMED}`);
    expect(res.status).toBe(200);
    const mentions = (
      res.body as {
        mentions: { id: string; source: string; content: string; writer: { pubkey: string }; where: { id: string; type: string } }[];
      }
    ).mentions;
    const row = mentions.find((m) => m.id === AMENDMENT);
    expect(row).toBeDefined();
    // The naming writer comes from the denormalised author, not from a comment.
    expect(row?.writer.pubkey).toBe(WRITER);
    expect(row?.source).toBe('tag');
    expect(row?.content).toBe('');
    expect(row?.where).toMatchObject({ id: FLICK, type: 'flick' });
  });

  it('drops the tag the moment the amendment is buffed', async () => {
    await seed.query('delete from events where id = $1', [AMENDMENT]);
    const res = await request(app, `/mentions/${NAMED}`);
    const ids = (res.body as { mentions: { id: string }[] }).mentions.map((m) => m.id);
    expect(ids).not.toContain(AMENDMENT);
  });
});
