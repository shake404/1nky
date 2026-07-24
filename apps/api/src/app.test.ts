import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { encodeCursor } from './cursor.js';
import {
  brokenDb,
  commentRow,
  fakeDb,
  flickRow,
  hex,
  request,
  type Responder,
  TEST_CONFIG,
} from './testing/fixtures.js';

const AUTHOR = hex('ab');
const FLICK_ID = hex('11');

function app(responder?: Responder) {
  return createApp(fakeDb(responder), TEST_CONFIG);
}

/**
 * Routes by the table each query reads from, which is enough to fake a
 * database. Order matters: several queries embed a lateral subquery against
 * `flicks` or `comments`, so the outermost table is matched first.
 */
const responder: Responder = (text) => {
  if (text.includes('from boards b')) {
    return {
      rows: [
        { slug: 'sf', title: 'San Francisco', kind: 'city', created_at: '1', flick_count: 3, latest_at: '5' },
      ],
    };
  }
  if (text.includes('from reports r')) {
    return {
      rows: [
        {
          event_id: hex('99'),
          reporter: hex('ef'),
          target_pubkey: AUTHOR,
          target_event: FLICK_ID,
          reason: 'illegal',
          note: 'look at this',
          created_at: '1700000000',
          target_kind: 20,
          target_content: 'rooftop',
          target_created_at: '1699999999',
          thumbnail_url: 'https://cdn.example/a.webp',
          thumbnail_blurhash: 'LEHV6n',
          target_boards: ['sf'],
          target_tag_name: 'SMOG',
          reporter_first_event_at: '1690000000',
          reporter_event_count: 4,
          reporter_report_count: 0,
          target_report_count: 3,
          target_banned: false,
        },
      ],
    };
  }
  if (text.includes('from banned_pubkeys b\n')) {
    return {
      rows: [
        { pubkey: AUTHOR, reason: 'spam', banned_at: '1700000000', banned_by: hex('ef'), report_count: 5, event_count: 20 },
      ],
    };
  }
  if (text.includes('from flicks f')) return { rows: [flickRow()] };
  if (text.includes('from comments c')) return { rows: [commentRow()] };
  if (text.includes('from profiles p')) {
    return {
      rows: [
        {
          pubkey: AUTHOR,
          tag_name: 'SMOG',
          city: 'sf',
          avatar_sha256: null,
          first_seen: '1700000000',
          updated_at: '1700000000',
          event_count: '9',
          first_event_at: '1699000000',
          banned: false,
        },
      ],
    };
  }
  return undefined;
};

describe('GET /healthz', () => {
  it('is ok when the database answers', async () => {
    const res = await request(app(), '/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: true });
  });

  it('is 503 when it does not', async () => {
    const res = await request(createApp(brokenDb(), TEST_CONFIG), '/healthz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'degraded', db: false });
  });
});

describe('GET /feed', () => {
  it('returns shaped flicks', async () => {
    const res = await request(app(responder), '/feed');
    expect(res.status).toBe(200);
    const body = res.body as { flicks: unknown[]; nextCursor: string | null; board: string | null };
    expect(body.board).toBeNull();
    expect(body.flicks).toHaveLength(1);
    expect(body.flicks[0]).toMatchObject({ id: FLICK_ID, caption: 'rooftop', replyCount: 2 });
    expect(body.nextCursor).toBeNull();
  });

  it('normalises the board slug before querying', async () => {
    const db = fakeDb(responder);
    await request(createApp(db, TEST_CONFIG), '/feed?board=SF%20Bay');
    expect(db.matching('from flicks f')[0]?.params[0]).toBe('sf-bay');
  });

  it('caps the limit at 50 however big the client asks for', async () => {
    const db = fakeDb(responder);
    await request(createApp(db, TEST_CONFIG), '/feed?limit=5000');
    expect(db.matching('from flicks f')[0]?.params[3]).toBe(50);
  });

  it('rejects a nonsense limit', async () => {
    const res = await request(app(responder), '/feed?limit=-3');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('rejects a forged cursor', async () => {
    const res = await request(app(responder), '/feed?cursor=notacursor');
    expect(res.status).toBe(400);
  });

  it('passes a valid cursor through as a keyset bound', async () => {
    const db = fakeDb(responder);
    const cursor = encodeCursor({ createdAt: 1_700_000_000, eventId: FLICK_ID });
    await request(createApp(db, TEST_CONFIG), `/feed?cursor=${cursor}`);
    const params = db.matching('from flicks f')[0]?.params;
    expect(params?.[1]).toBe(1_700_000_000);
    expect(params?.[2]).toBe(FLICK_ID);
  });

  it('hands back a cursor when the page is full', async () => {
    const db = fakeDb(() => ({ rows: Array.from({ length: 2 }, () => flickRow()) }));
    const res = await request(createApp(db, TEST_CONFIG), '/feed?limit=2');
    expect((res.body as { nextCursor: string | null }).nextCursor).toBeTypeOf('string');
  });
});

describe('GET /flick/:id', () => {
  it('returns the flick with its thread', async () => {
    const res = await request(app(responder), `/flick/${FLICK_ID}`);
    expect(res.status).toBe(200);
    const body = res.body as { flick: { id: string; replyCount: number }; comments: unknown[] };
    expect(body.flick.id).toBe(FLICK_ID);
    expect(body.comments).toHaveLength(1);
    expect(body.flick.replyCount).toBe(1);
  });

  it('404s for an unknown flick', async () => {
    const res = await request(app(), `/flick/${FLICK_ID}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'not_found' } });
  });

  it('400s for an id that is not an event id', async () => {
    expect((await request(app(responder), '/flick/nope')).status).toBe(400);
  });
});

describe('GET /boards', () => {
  it('lists boards with counts', async () => {
    const res = await request(app(responder), '/boards');
    expect(res.body).toEqual({
      boards: [
        { slug: 'sf', title: 'San Francisco', kind: 'city', createdAt: 1, flickCount: 3, latestAt: 5 },
      ],
    });
  });
});

describe('GET /writer/:pubkey', () => {
  it('returns the profile and their flicks', async () => {
    const res = await request(app(responder), `/writer/${AUTHOR}`);
    expect(res.status).toBe(200);
    const body = res.body as { writer: { tag: string; mark: string }; flicks: unknown[] };
    expect(body.writer.tag).toBe('SMOG');
    expect(body.writer.mark).toHaveLength(6);
    expect(body.flicks).toHaveLength(1);
  });

  it('404s when there is neither a profile nor a flick', async () => {
    expect((await request(app(), `/writer/${AUTHOR}`)).status).toBe(404);
  });

  it('resolves a writer who has flicks but never set a tag', async () => {
    const res = await request(
      app((text) => (text.includes('from flicks f') ? { rows: [flickRow()] } : { rows: [] })),
      `/writer/${AUTHOR}`,
    );
    expect(res.status).toBe(200);
    expect((res.body as { writer: { tag: null } }).writer.tag).toBeNull();
  });
});

describe('GET /search', () => {
  it('requires a query', async () => {
    const res = await request(app(responder), '/search');
    expect(res.status).toBe(400);
  });

  it('returns matching flicks and the boards it looked in', async () => {
    const res = await request(app(responder), '/search?q=oakland');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ q: 'oakland', boards: ['oakland'] });
    expect((res.body as { flicks: unknown[] }).flicks).toHaveLength(1);
  });

  it('rejects an absurdly long query', async () => {
    expect((await request(app(responder), `/search?q=${'a'.repeat(200)}`)).status).toBe(400);
  });
});

describe('/mod/*', () => {
  const key = { headers: { 'X-Mod-Key': 'test-mod-key' } };

  it('401s without the shared secret', async () => {
    const res = await request(app(responder), '/mod/queue');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('401s with the wrong secret', async () => {
    const res = await request(app(responder), '/mod/queue', {
      headers: { 'X-Mod-Key': 'not-the-key' },
    });
    expect(res.status).toBe(401);
  });

  it('503s when no secret is configured at all', async () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://x/y' } as NodeJS.ProcessEnv);
    const res = await request(createApp(fakeDb(responder), config), '/mod/queue', key);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { code: 'mod_disabled' } });
  });

  it('returns the queue with thumbnail and reporter stats', async () => {
    const res = await request(app(responder), '/mod/queue', key);
    expect(res.status).toBe(200);
    const report = (res.body as { reports: Record<string, never>[] }).reports[0];
    expect(report).toMatchObject({
      reason: 'illegal',
      reporter: { eventCount: 4, reportCount: 0 },
      target: { thumbnailUrl: 'https://cdn.example/a.webp', reportCount: 3, present: true },
    });
  });

  it('returns the ban list', async () => {
    const res = await request(app(responder), '/mod/banlist', key);
    expect(res.status).toBe(200);
    expect((res.body as { banned: { pubkey: string }[] }).banned[0]?.pubkey).toBe(AUTHOR);
  });
});

describe('the shape of the service itself', () => {
  it('allows any origin, with no credentials', async () => {
    const res = await request(app(responder), '/boards');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('answers preflight', async () => {
    const res = await request(app(), '/feed', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('refuses every write method — writes are signed events to the relay', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await request(app(responder), '/feed', { method });
      expect(res.status).toBe(405);
      expect(res.body).toMatchObject({ error: { code: 'read_only' } });
    }
  });

  it('sets no cookie on any response', async () => {
    const res = await request(app(responder), '/feed');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('404s unknown endpoints as JSON', async () => {
    const res = await request(app(), '/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('turns an unexpected database failure into a 500 without detail', async () => {
    const res = await request(createApp(brokenDb('relation "flicks" does not exist'), TEST_CONFIG), '/feed');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'internal', message: 'Something broke.' } });
  });
});
