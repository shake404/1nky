import {
  buildBuff,
  buildComment,
  buildFlick,
  buildInvite,
  buildModBan,
  buildProfile,
  buildThreadOp,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  KINDS,
} from '@1nky/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect, type Database } from './db.js';
import { invitedListJson } from './invited-export.js';
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

  it('stores a thread OP, its board and its replies', async () => {
    const counters = newCounters();
    const op = finalizeEvent(
      buildThreadOp({
        subject: 'Who buffed the Alameda wall?',
        boards: ['sf', 'oakland'],
        content: 'gone as of this morning',
        createdAt: now - 300,
      }),
      sk,
    );
    await indexEvent(db, op, counters, { now });

    const reply = finalizeEvent(
      buildComment(
        { id: op.id, pubkey: op.pubkey, kind: KINDS.NOTE },
        { content: 'saw the truck', createdAt: now - 100 },
      ),
      sk,
    );
    await indexEvent(db, reply, counters, { now });

    const { rows } = await db.query<{ subject: string | null; boards: string[]; replies: string }>(
      `select t.subject, t.boards,
              (select count(*)::text from comments c where c.root_id = t.event_id) as replies
         from threads t where t.event_id = $1`,
      [op.id],
    );
    expect(rows[0]?.subject).toBe('Who buffed the Alameda wall?');
    expect(rows[0]?.boards).toEqual(['sf', 'oakland']);
    expect(rows[0]?.replies).toBe('1');

    // The board was auto-discovered from the thread's `t` tags.
    const boards = await db.query('select 1 from boards where slug = $1', ['oakland']);
    expect(boards.rows).toHaveLength(1);
  });

  it('files a deliberate mention and lets a buff take it away', async () => {
    const counters = newCounters();
    const namedSk = generateSecretKey();
    const named = getPublicKey(namedSk);

    const op = finalizeEvent(
      buildThreadOp({ subject: 'who was that', boards: ['sf'], createdAt: now - 400, content: 'x' }),
      sk,
    );
    await indexEvent(db, op, counters, { now });

    const ref = { id: op.id, pubkey: op.pubkey, kind: KINDS.NOTE };
    const named_reply = finalizeEvent(
      buildComment(ref, { content: 'ask @them', mentions: [named], createdAt: now - 100 }),
      sk,
    );
    const plain_reply = finalizeEvent(
      buildComment(ref, { content: 'no idea', createdAt: now - 90 }),
      sk,
    );
    await indexEvent(db, named_reply, counters, { now });
    await indexEvent(db, plain_reply, counters, { now });

    const inbox = async (pubkey: string) =>
      (
        await db.query<{ event_id: string; root_id: string; author_pubkey: string }>(
          'select event_id, root_id, author_pubkey from mentions where mentioned_pubkey = $1',
          [pubkey],
        )
      ).rows;

    expect(await inbox(named)).toEqual([
      { event_id: named_reply.id, root_id: op.id, author_pubkey: op.pubkey },
    ]);
    // The thread author is `p`-tagged by BOTH replies (that is how NIP-22
    // addresses one) and mentioned by neither.
    expect(await inbox(op.pubkey)).toEqual([]);

    // Buff the comment and the mention goes with it, through the cascade —
    // there is no second delete to remember.
    await indexEvent(
      db,
      finalizeEvent(buildBuff([named_reply.id], { kinds: [KINDS.COMMENT] }), sk),
      counters,
      { now },
    );
    expect(await inbox(named)).toEqual([]);
  });

  it('stores a happening date on the thread row and rebuilds it from the event', async () => {
    const counters = newCounters();
    const happeningAt = now + 86_400;
    const op = finalizeEvent(
      buildThreadOp({
        subject: 'Yard jam',
        boards: ['oakland'],
        content: 'bring paint',
        happeningAt,
        createdAt: now - 300,
      }),
      sk,
    );
    await indexEvent(db, op, counters, { now });

    const read = async () =>
      (
        await db.query<{ happening_at: string | null; boards: string[] }>(
          'select happening_at, boards from threads where event_id = $1',
          [op.id],
        )
      ).rows[0];

    const row = await read();
    expect(Number(row?.happening_at)).toBe(happeningAt);
    expect(row?.boards).toContain('happening');

    // The marker registers as its own board kind, never as a city.
    const marker = await db.query<{ kind: string }>('select kind from boards where slug = $1', [
      'happening',
    ]);
    expect(marker.rows[0]?.kind).toBe('happening');

    // DERIVED: the column comes off the event's `when` tag, so a rebuild
    // reproduces it with nothing extra to replay.
    await truncateDerived(db);
    expect(await read()).toBeUndefined();
    await indexEvent(db, op, newCounters(), { now });
    expect(Number((await read())?.happening_at)).toBe(happeningAt);
  });

  it('leaves happening_at null for an ordinary thread', async () => {
    const counters = newCounters();
    const op = finalizeEvent(
      buildThreadOp({ subject: 'no date', boards: ['sf'], content: 'just a thread' }),
      sk,
    );
    await indexEvent(db, op, counters, { now });

    const { rows } = await db.query<{ happening_at: string | null }>(
      'select happening_at from threads where event_id = $1',
      [op.id],
    );
    expect(rows[0]?.happening_at).toBeNull();
  });

  it('buffs a thread OP and cascades the row out of threads', async () => {
    const counters = newCounters();
    const op = finalizeEvent(
      buildThreadOp({ subject: 'buff me', boards: ['sf'], content: 'temporary' }),
      sk,
    );
    await indexEvent(db, op, counters, { now });
    await indexEvent(db, finalizeEvent(buildBuff([op.id], { kinds: [1] }), sk), counters, { now });

    expect((await db.query('select 1 from threads where event_id = $1', [op.id])).rows).toEqual([]);
    expect((await db.query('select 1 from events where id = $1', [op.id])).rows).toEqual([]);
  });

  it('repopulates threads after a rebuild truncates them', async () => {
    const counters = newCounters();
    const op = finalizeEvent(
      buildThreadOp({ subject: 'rebuild me', boards: ['sf'], content: 'replayed' }),
      sk,
    );
    await indexEvent(db, op, counters, { now });
    expect((await db.query('select 1 from threads where event_id = $1', [op.id])).rows).toHaveLength(1);

    // `threads` is DERIVED: a rebuild throws it away...
    await truncateDerived(db);
    expect((await db.query('select 1 from threads where event_id = $1', [op.id])).rows).toEqual([]);

    // ...and replaying the same event from the relay puts it back.
    await indexEvent(db, op, newCounters(), { now });
    expect((await db.query('select 1 from threads where event_id = $1', [op.id])).rows).toHaveLength(1);
  });

  it('sweeps an expired beef out of threads too', async () => {
    const counters = newCounters();
    const beef = finalizeEvent(
      buildThreadOp({
        subject: 'beef',
        boards: ['sf'],
        content: '24h only',
        expiration: now + 60,
      }),
      sk,
    );
    await indexEvent(db, beef, counters, { now });
    expect((await db.query('select 1 from threads where event_id = $1', [beef.id])).rows).toHaveLength(1);

    expect(await sweepExpired(db, now + 61)).toBeGreaterThanOrEqual(1);
    expect((await db.query('select 1 from threads where event_id = $1', [beef.id])).rows).toEqual([]);
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

// ---------------------------------------------------------------------------
// Invite trees ("getting put on") against a live Postgres.
//
// These live here rather than in store.test.ts because the rules that matter are
// the ones Postgres enforces: every redemption guard is a predicate on one
// UPDATE, and the subtree cascade is a recursive CTE. A fake database can assert
// that the statement was issued; only a real one proves it does the right thing.
// ---------------------------------------------------------------------------

describe.skipIf(!enabled)('invite trees against a live Postgres', () => {
  let db: Database;
  const now = Math.floor(Date.now() / 1000);

  /** A fresh keypair per call, so no test can inherit another's edges. */
  let seq = 0;
  function writer(): { sk: Uint8Array; pk: string } {
    seq += 1;
    const sk = generateSecretKey();
    return { sk, pk: getPublicKey(sk) };
  }

  /** A 16-hex invite id, unique per label. */
  function inviteId(label: string): string {
    return `${label}${String(seq).padStart(2, '0')}`.padEnd(16, '0').slice(0, 16);
  }

  async function mint(sk: Uint8Array, id: string, createdAt = now): Promise<void> {
    await indexEvent(db, finalizeEvent(buildInvite(id, { createdAt }), sk), newCounters(), { now });
  }

  /** Redeems and returns how many edges were created (0 = the claim was refused). */
  async function redeem(
    sk: Uint8Array,
    id: string,
    inviter: string,
    createdAt = now + 1,
  ): Promise<number> {
    const counters = newCounters();
    await indexEvent(
      db,
      finalizeEvent(
        buildProfile({
          tag: 'NEWJACK',
          invite: { inviteId: id, inviterPubkey: inviter },
          createdAt,
        }),
        sk,
      ),
      counters,
      { now: createdAt },
    );
    return counters.putOn;
  }

  async function parentOf(child: string): Promise<string | undefined> {
    const { rows } = await db.query<{ parent: string }>(
      'select parent from invite_edges where child = $1',
      [child],
    );
    return rows[0]?.parent;
  }

  async function isBanned(pubkey: string): Promise<boolean> {
    const { rows } = await db.query('select 1 from banned_pubkeys where pubkey = $1', [pubkey]);
    return rows.length === 1;
  }

  beforeAll(async () => {
    db = connect(DATABASE_URL);
    await migrate(db);
    await truncateDerived(db);
    await db.query('delete from banned_pubkeys');
  });

  afterAll(async () => {
    if (db) await db.end();
  });

  it('mints an invite and redeems it into an edge', async () => {
    const a = writer();
    const b = writer();
    const id = inviteId('aa');

    await mint(a.sk, id);
    const minted = await db.query<{ inviter: string; redeemed_by: string | null }>(
      'select inviter, redeemed_by from invites where invite_id = $1',
      [id],
    );
    expect(minted.rows[0]?.inviter).toBe(a.pk);
    expect(minted.rows[0]?.redeemed_by).toBeNull();

    expect(await redeem(b.sk, id, a.pk)).toBe(1);
    expect(await parentOf(b.pk)).toBe(a.pk);

    const after = await db.query<{ redeemed_by: string | null; redeemed_at: string | null }>(
      'select redeemed_by, redeemed_at from invites where invite_id = $1',
      [id],
    );
    expect(after.rows[0]?.redeemed_by).toBe(b.pk);
    expect(after.rows[0]?.redeemed_at).not.toBeNull();
  });

  it('keeps the first mint of an id and ignores a later claim on it', async () => {
    const a = writer();
    const b = writer();
    const id = inviteId('bb');

    await mint(a.sk, id, now - 100);
    await mint(b.sk, id, now);

    const { rows } = await db.query<{ inviter: string }>(
      'select inviter from invites where invite_id = $1',
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inviter).toBe(a.pk);
  });

  it('lets a banned writer mint nothing', async () => {
    const a = writer();
    const id = inviteId('cc');
    await db.query(
      'insert into banned_pubkeys (pubkey, reason, banned_at, banned_by) values ($1, $2, $3, $4)',
      [a.pk, 'spam', now, a.pk],
    );
    try {
      await mint(a.sk, id);
      expect((await db.query('select 1 from invites where invite_id = $1', [id])).rows).toEqual([]);
    } finally {
      await db.query('delete from banned_pubkeys where pubkey = $1', [a.pk]);
    }
  });

  it('refuses a self-invite', async () => {
    const a = writer();
    const id = inviteId('dd');
    await mint(a.sk, id);
    expect(await redeem(a.sk, id, a.pk)).toBe(0);
    expect(await parentOf(a.pk)).toBeUndefined();
  });

  it('refuses a redemption naming an inviter who did not mint it', async () => {
    const a = writer();
    const impostor = writer();
    const b = writer();
    const id = inviteId('ee');

    await mint(a.sk, id);
    expect(await redeem(b.sk, id, impostor.pk)).toBe(0);
    expect(await parentOf(b.pk)).toBeUndefined();
    // Still open for the writer it was actually meant for.
    expect(await redeem(b.sk, id, a.pk)).toBe(1);
  });

  it('refuses a redemption when the inviter has since been banned', async () => {
    const a = writer();
    const b = writer();
    const id = inviteId('ff');
    await mint(a.sk, id);
    await db.query(
      'insert into banned_pubkeys (pubkey, reason, banned_at, banned_by) values ($1, $2, $3, $4)',
      [a.pk, 'spam', now, a.pk],
    );
    try {
      expect(await redeem(b.sk, id, a.pk)).toBe(0);
      expect(await parentOf(b.pk)).toBeUndefined();
    } finally {
      await db.query('delete from banned_pubkeys where pubkey = $1', [a.pk]);
    }
  });

  it('gives a writer ONE parent, forever - the first redemption wins', async () => {
    const a = writer();
    const c = writer();
    const b = writer();
    const first = inviteId('1a');
    const second = inviteId('1b');

    await mint(a.sk, first);
    await mint(c.sk, second);

    expect(await redeem(b.sk, first, a.pk)).toBe(1);
    expect(await redeem(b.sk, second, c.pk, now + 500)).toBe(0);
    expect(await parentOf(b.pk)).toBe(a.pk);

    // The refused invite is untouched and still open for somebody else.
    const { rows } = await db.query<{ redeemed_by: string | null }>(
      'select redeemed_by from invites where invite_id = $1',
      [second],
    );
    expect(rows[0]?.redeemed_by).toBeNull();
  });

  it('is idempotent on a replayed redemption', async () => {
    const a = writer();
    const b = writer();
    const id = inviteId('1c');
    await mint(a.sk, id);

    expect(await redeem(b.sk, id, a.pk, now + 1)).toBe(1);
    // A second kind-0 making the same claim: the invite still passes the
    // redeemed_by check (same writer), but the edge already exists.
    expect(await redeem(b.sk, id, a.pk, now + 2)).toBe(0);

    const edges = await db.query('select 1 from invite_edges where child = $1', [b.pk]);
    expect(edges.rows).toHaveLength(1);
  });

  it('bans a whole branch from the middle, leaving the root alone', async () => {
    const modSk = generateSecretKey();
    const mod = getPublicKey(modSk);
    const mods: ReadonlySet<string> = new Set([mod]);

    // root -> middle -> leafOne -> leafTwo: four generations, so the cascade has
    // to be transitive rather than one level deep.
    const root = writer();
    const middle = writer();
    const leafOne = writer();
    const leafTwo = writer();

    const one = inviteId('2a');
    const two = inviteId('2b');
    const three = inviteId('2c');
    await mint(root.sk, one);
    expect(await redeem(middle.sk, one, root.pk)).toBe(1);
    await mint(middle.sk, two);
    expect(await redeem(leafOne.sk, two, middle.pk)).toBe(1);
    await mint(leafOne.sk, three);
    expect(await redeem(leafTwo.sk, three, leafOne.pk)).toBe(1);

    const counters = newCounters();
    await indexEvent(
      db,
      finalizeEvent(
        buildModBan(middle.pk, 'ban', { reason: 'tag farm', subtree: true, createdAt: now + 10 }),
        modSk,
      ),
      counters,
      { now: now + 10, modPubkeys: mods },
    );

    expect(counters.bans).toBe(1);
    expect(counters.subtreeBans).toBe(2);
    expect(await isBanned(middle.pk)).toBe(true);
    expect(await isBanned(leafOne.pk)).toBe(true);
    expect(await isBanned(leafTwo.pk)).toBe(true);
    // Upward is untouched: vouching for somebody who turned out bad is not a
    // crime, and a cascade that walked up would ban half the site.
    expect(await isBanned(root.pk)).toBe(false);

    // Every descendant carries the same reason, moderator and instant, so the
    // moderation log reads as one action.
    const { rows } = await db.query<{ reason: string; banned_at: string; banned_by: string }>(
      'select reason, banned_at, banned_by from banned_pubkeys where pubkey = any($1::text[])',
      [[middle.pk, leafOne.pk, leafTwo.pk]],
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.reason).toBe('tag farm');
      expect(Number(row.banned_at)).toBe(now + 10);
      expect(row.banned_by).toBe(mod);
    }

    // An unban of the middle lifts ONLY the middle: each descendant may have
    // earned their own ban since, so lifting never cascades.
    await indexEvent(
      db,
      finalizeEvent(buildModBan(middle.pk, 'unban', { createdAt: now + 20 }), modSk),
      newCounters(),
      { now: now + 20, modPubkeys: mods },
    );
    expect(await isBanned(middle.pk)).toBe(false);
    expect(await isBanned(leafOne.pk)).toBe(true);
    expect(await isBanned(leafTwo.pk)).toBe(true);

    await db.query('delete from banned_pubkeys where pubkey = any($1::text[])', [
      [leafOne.pk, leafTwo.pk],
    ]);
  });

  it('terminates on a cycle instead of recursing forever', async () => {
    const modSk = generateSecretKey();
    const mods: ReadonlySet<string> = new Set([getPublicKey(modSk)]);

    // Legal in the schema: a puts b on, then later b puts a on, because a had no
    // parent at the time. `union all` in the cascade would spin on this.
    const a = writer();
    const b = writer();
    const one = inviteId('3a');
    const two = inviteId('3b');

    await mint(a.sk, one);
    expect(await redeem(b.sk, one, a.pk)).toBe(1);
    await mint(b.sk, two);
    expect(await redeem(a.sk, two, b.pk, now + 5)).toBe(1);

    await indexEvent(
      db,
      finalizeEvent(buildModBan(a.pk, 'ban', { subtree: true, createdAt: now + 10 }), modSk),
      newCounters(),
      { now: now + 10, modPubkeys: mods },
    );

    expect(await isBanned(a.pk)).toBe(true);
    expect(await isBanned(b.pk)).toBe(true);

    await db.query('delete from banned_pubkeys where pubkey = any($1::text[])', [[a.pk, b.pk]]);
  });

  it('leaves the branch alone for an ordinary ban', async () => {
    const modSk = generateSecretKey();
    const mods: ReadonlySet<string> = new Set([getPublicKey(modSk)]);
    const a = writer();
    const b = writer();
    const id = inviteId('4a');

    await mint(a.sk, id);
    expect(await redeem(b.sk, id, a.pk)).toBe(1);

    await indexEvent(
      db,
      finalizeEvent(buildModBan(a.pk, 'ban', { reason: 'spam', createdAt: now + 10 }), modSk),
      newCounters(),
      { now: now + 10, modPubkeys: mods },
    );

    expect(await isBanned(a.pk)).toBe(true);
    expect(await isBanned(b.pk)).toBe(false);
    await db.query('delete from banned_pubkeys where pubkey = $1', [a.pk]);
  });

  it('rebuilds the whole forest from the relay - both tables are derived', async () => {
    const a = writer();
    const b = writer();
    const id = inviteId('5a');

    const mintEvent = finalizeEvent(buildInvite(id, { createdAt: now }), a.sk);
    const redeemEvent = finalizeEvent(
      buildProfile({
        tag: 'NEWJACK',
        invite: { inviteId: id, inviterPubkey: a.pk },
        createdAt: now + 1,
      }),
      b.sk,
    );
    await indexEvent(db, mintEvent, newCounters(), { now });
    await indexEvent(db, redeemEvent, newCounters(), { now: now + 1 });
    expect(await parentOf(b.pk)).toBe(a.pk);

    await truncateDerived(db);
    expect(await parentOf(b.pk)).toBeUndefined();
    expect((await db.query('select 1 from invites where invite_id = $1', [id])).rows).toEqual([]);

    // Replaying the same two events puts the whole branch back.
    await indexEvent(db, mintEvent, newCounters(), { now });
    await indexEvent(db, redeemEvent, newCounters(), { now: now + 1 });
    expect(await parentOf(b.pk)).toBe(a.pk);
  });

  it('exports exactly what the relay write policy will load', async () => {
    const { rows } = await db.query<{ pubkey: string }>(
      'select child as pubkey from invite_edges order by child',
    );
    expect(rows.length).toBeGreaterThan(0);
    const json = invitedListJson(rows);
    // Bare hex strings, sorted, no reasons and nothing about the tree.
    expect(JSON.parse(json)).toEqual(rows.map((r) => r.pubkey));
    expect(json).not.toContain('parent');
  });

  it('walks the same branch the API tree endpoint serves', async () => {
    // The mod console's "ban the whole branch" preview and the indexer's cascade
    // must agree, so the recursive CTE the API runs is exercised here too.
    const a = writer();
    const b = writer();
    const c = writer();
    const one = inviteId('6a');
    const two = inviteId('6b');

    await mint(a.sk, one);
    expect(await redeem(b.sk, one, a.pk)).toBe(1);
    await mint(b.sk, two);
    expect(await redeem(c.sk, two, b.pk)).toBe(1);

    const { rows } = await db.query<{ pubkey: string; parent: string }>(
      `with recursive sub as (
         select e.child, e.parent, e.redeemed_at from invite_edges e where e.parent = $1
         union
         select e.child, e.parent, e.redeemed_at from invite_edges e join sub on e.parent = sub.child
       )
       select sub.child as pubkey, sub.parent from sub order by sub.redeemed_at asc, sub.child asc`,
      [a.pk],
    );
    expect(rows.map((r) => r.pubkey).sort()).toEqual([b.pk, c.pk].sort());
  });
});
