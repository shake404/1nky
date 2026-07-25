import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import {
  brokenDb,
  commentRow,
  fakeDb,
  flickRow,
  hex,
  request,
  type Responder,
  TEST_CONFIG,
  threadRow,
  threadSummaryRow,
  videoRow,
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
        {
          slug: 'sf',
          title: 'San Francisco',
          kind: 'city',
          region_slug: 'region-bay-area',
          created_at: '1',
          flick_count: 3,
          thread_count: 7,
          latest_at: '5',
        },
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
  // `from flicks f` first: the unified feed/explore queries name both tables.
  if (text.includes('from flicks f')) return { rows: [flickRow()] };
  if (text.includes('from videos v')) return { rows: [videoRow()] };
  if (text.includes('from threads t')) return { rows: [threadSummaryRow()] };
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

  it('includes videos alongside flicks, each tagged with its mediaType', async () => {
    const db = fakeDb((text) => {
      if (text.includes('from flicks f')) return { rows: [flickRow(), videoRow()] };
      return undefined;
    });
    const res = await request(createApp(db, TEST_CONFIG), '/feed?limit=10');
    expect(res.status).toBe(200);
    const items = (res.body as {
      flicks: { mediaType: string; posterUrl: string | null; duration: number | null }[];
    }).flicks;
    expect(items).toHaveLength(2);
    expect(items[0]?.mediaType).toBe('flick');
    expect(items[0]?.posterUrl).toBeNull();
    expect(items[0]?.duration).toBeNull();
    expect(items[1]?.mediaType).toBe('video');
    expect(items[1]?.posterUrl).toBe('https://cdn.example/p.webp');
    expect(items[1]?.duration).toBe(12);
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
        {
          slug: 'sf',
          title: 'San Francisco',
          kind: 'city',
          regionSlug: 'region-bay-area',
          createdAt: 1,
          flickCount: 3,
          threadCount: 7,
          latestAt: 5,
        },
      ],
    });
  });

  it('passes ?kind= through to the query', async () => {
    const db = fakeDb(responder);
    await request(createApp(db, TEST_CONFIG), '/boards?kind=type');
    expect(db.matching('from boards b')[0]?.params).toEqual(['type']);
  });

  it('rejects a kind that is not a facet', async () => {
    const res = await request(app(responder), '/boards?kind=nonsense');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('reports zero rather than null for a board nobody has posted to', async () => {
    const db = fakeDb((text) =>
      text.includes('from boards b')
        ? {
            rows: [
              {
                slug: 'fresno',
                title: 'fresno',
                kind: 'city',
                region_slug: null,
                created_at: '1',
                flick_count: 0,
                thread_count: 0,
                latest_at: null,
              },
            ],
          }
        : undefined,
    );
    const res = await request(createApp(db, TEST_CONFIG), '/boards');
    expect((res.body as { boards: Record<string, unknown>[] }).boards[0]).toMatchObject({
      flickCount: 0,
      threadCount: 0,
      latestAt: null,
      regionSlug: null,
    });
  });
});

describe('GET /board/:slug', () => {
  const boardDb = (threads: unknown[] = [threadSummaryRow()], header?: Record<string, unknown>) =>
    fakeDb((text) => {
      if (text.includes('from (select $1::text as slug) x')) {
        return {
          rows: [
            {
              slug: 'sf',
              title: 'San Francisco',
              kind: 'city',
              region_slug: 'region-bay-area',
              has_media: true,
              ...header,
            },
          ],
        };
      }
      if (text.includes('from threads t')) return { rows: threads };
      return undefined;
    });

  it('returns the board and its threads', async () => {
    const res = await request(createApp(boardDb(), TEST_CONFIG), '/board/sf');
    expect(res.status).toBe(200);
    const body = res.body as {
      board: { slug: string; title: string; kind: string; regionSlug: string | null };
      threads: {
        id: string;
        subject: string;
        excerpt: string;
        createdAt: number;
        expiresAt: number | null;
        replyCount: number;
        lastReplyAt: number | null;
        writer: { tag: string; mark: string };
      }[];
      nextCursor: string | null;
    };
    expect(body.board).toEqual({
      slug: 'sf',
      title: 'San Francisco',
      kind: 'city',
      regionSlug: 'region-bay-area',
    });
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]).toMatchObject({
      id: hex('55'),
      subject: 'Who buffed the Alameda wall?',
      excerpt: 'gone as of this morning',
      createdAt: 1_700_000_000,
      expiresAt: null,
      replyCount: 3,
      lastReplyAt: 1_700_000_900,
    });
    expect(body.threads[0]?.writer.tag).toBe('SMOG');
    expect(body.threads[0]?.writer.mark).toHaveLength(6);
    expect(body.nextCursor).toBeNull();
  });

  it('normalises the slug before querying', async () => {
    const db = boardDb();
    await request(createApp(db, TEST_CONFIG), '/board/SF%20Bay');
    expect(db.matching('from threads t')[0]?.params[0]).toBe('sf-bay');
  });

  it('paginates on the activity sort key, not the OP timestamp', async () => {
    const rows = Array.from({ length: 2 }, (_, i) =>
      threadSummaryRow({ event_id: hex(String(i + 1).repeat(2)), sort_at: '1700009999' }),
    );
    const res = await request(createApp(boardDb(rows), TEST_CONFIG), '/board/sf?limit=2');
    const cursor = (res.body as { nextCursor: string | null }).nextCursor;
    expect(cursor).toBeTypeOf('string');
    expect(decodeCursor(cursor as string)?.createdAt).toBe(1_700_009_999);
  });

  it('passes a cursor through as the keyset bound', async () => {
    const db = boardDb();
    const cursor = encodeCursor({ createdAt: 1_700_000_900, eventId: hex('55') });
    await request(createApp(db, TEST_CONFIG), `/board/sf?cursor=${cursor}`);
    const params = db.matching('from threads t')[0]?.params;
    expect(params?.[1]).toBe(1_700_000_900);
    expect(params?.[2]).toBe(hex('55'));
  });

  it('surfaces a beef expiry so the client can count down', async () => {
    const res = await request(
      createApp(boardDb([threadSummaryRow({ expires_at: '1700086400' })]), TEST_CONFIG),
      '/board/sf',
    );
    expect((res.body as { threads: { expiresAt: number }[] }).threads[0]?.expiresAt).toBe(1_700_086_400);
  });

  it('200s for a board nobody registered but writers have been tagging', async () => {
    const res = await request(
      createApp(boardDb([threadSummaryRow()], { title: null, kind: null, has_media: false }), TEST_CONFIG),
      '/board/sf',
    );
    expect(res.status).toBe(200);
    // With no registry row the slug is its own title.
    expect((res.body as { board: { title: string; kind: string } }).board).toMatchObject({
      title: 'sf',
      kind: 'city',
    });
  });

  it('404s for a slug with no board, no threads and no media', async () => {
    const res = await request(
      createApp(boardDb([], { title: null, kind: null, has_media: false }), TEST_CONFIG),
      '/board/nowhere',
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'not_found' } });
  });

  it('400s for a slug that normalises to nothing', async () => {
    expect((await request(app(responder), '/board/%23%23%23')).status).toBe(400);
  });
});

describe('GET /thread/:id', () => {
  const threadDb = (overrides: Record<string, unknown> = {}) =>
    fakeDb((text) => {
      if (text.includes('from threads t')) return { rows: [threadRow(overrides)] };
      if (text.includes('from comments c')) {
        return {
          rows: [
            commentRow({ event_id: hex('66'), parent_id: hex('55'), root_id: hex('55') }),
            commentRow({ event_id: hex('77'), parent_id: hex('66'), root_id: hex('55') }),
          ],
        };
      }
      return undefined;
    });

  it('returns the OP with its nested replies', async () => {
    const res = await request(createApp(threadDb(), TEST_CONFIG), `/thread/${hex('55')}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      thread: {
        id: string;
        subject: string;
        content: string;
        boards: string[];
        createdAt: number;
        expiresAt: number | null;
        replyCount: number;
        writer: { tag: string; mark: string };
      };
      comments: { id: string; replies: { id: string }[] }[];
    };
    expect(body.thread).toMatchObject({
      id: hex('55'),
      subject: 'Who buffed the Alameda wall?',
      content: 'gone as of this morning, whole panel',
      boards: ['sf', 'oakland'],
      createdAt: 1_700_000_000,
      expiresAt: null,
    });
    expect(body.thread.writer.tag).toBe('SMOG');
    // Nested, not flat: the second reply hangs off the first.
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]?.id).toBe(hex('66'));
    expect(body.comments[0]?.replies[0]?.id).toBe(hex('77'));
    // And the count is of the tree actually returned, at any depth.
    expect(body.thread.replyCount).toBe(2);
  });

  it('shows a thread with no subject — a bare OP is still a thread', async () => {
    const res = await request(createApp(threadDb({ subject: null }), TEST_CONFIG), `/thread/${hex('55')}`);
    expect(res.status).toBe(200);
    expect((res.body as { thread: { subject: null } }).thread.subject).toBeNull();
  });

  it('carries the beef expiry', async () => {
    const res = await request(
      createApp(threadDb({ expires_at: '1700086400' }), TEST_CONFIG),
      `/thread/${hex('55')}`,
    );
    expect((res.body as { thread: { expiresAt: number } }).thread.expiresAt).toBe(1_700_086_400);
  });

  it('404s for an unknown thread', async () => {
    const res = await request(app(), `/thread/${hex('55')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'not_found' } });
  });

  it('400s for an id that is not an event id', async () => {
    expect((await request(app(responder), '/thread/nope')).status).toBe(400);
  });

  it('refuses writes (read-only)', async () => {
    expect((await request(app(), `/thread/${hex('55')}`, { method: 'POST' })).status).toBe(405);
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

describe('GET /explore/facets', () => {
  it('classifies tags into cities, types, surfaces and regions', async () => {
    const db = fakeDb((text) => {
      if (text.includes('unnest(m.boards)')) {
        return {
          rows: [
            { slug: 'sf-bay', item_count: 3 },
            { slug: 'type-throwie', item_count: 5 },
            { slug: 'type-piece', item_count: 2 },
            { slug: 'surface-street', item_count: 4 },
            { slug: 'region-bay-area', item_count: 1 },
            { slug: 'legal-permission', item_count: 7 },
          ],
        };
      }
      return undefined;
    });
    const res = await request(createApp(db, TEST_CONFIG), '/explore/facets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      cities: [{ slug: 'sf-bay', count: 3 }],
      types: [
        { slug: 'throwie', count: 5 },
        { slug: 'piece', count: 2 },
      ],
      surfaces: [{ slug: 'street', count: 4 }],
      regions: [{ slug: 'bay-area', count: 1 }],
    });
  });

  it('is cache-friendly (CORS *, read-only)', async () => {
    const res = await request(app((text) => (text.includes('unnest(m.boards)') ? { rows: [] } : undefined)), '/explore/facets');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('GET /explore', () => {
  const exploreDb = (rows: unknown[] = []) =>
    fakeDb((text) => (text.includes('m.boards &&') ? { rows } : undefined));

  it('returns a unified, shaped feed filtered by facets', async () => {
    const res = await request(
      createApp(exploreDb([flickRow({ boards: ['sf-bay', 'type-throwie'] })]), TEST_CONFIG),
      '/explore?city=sf-bay&type=throwie&legal=true',
    );
    expect(res.status).toBe(200);
    const body = res.body as { flicks: { mediaType: string; boards: string[] }[]; nextCursor: string | null };
    expect(body.flicks).toHaveLength(1);
    expect(body.flicks[0]?.mediaType).toBe('flick');
    expect(body.flicks[0]?.boards).toEqual(['sf-bay', 'type-throwie']);
  });

  it('normalises and prefixes the facet values before querying', async () => {
    const db = exploreDb();
    await request(
      createApp(db, TEST_CONFIG),
      '/explore?city=SF%20Bay&type=Throwie&surface=Street&region=Bay%20Area&legal=true',
    );
    const call = db.matching('m.boards &&')[0];
    expect(call?.params[0]).toEqual(['sf-bay']);
    expect(call?.params[1]).toEqual(['type-throwie']);
    expect(call?.params[2]).toEqual(['surface-street']);
    expect(call?.params[3]).toEqual(['region-bay-area']);
    expect(call?.params[4]).toEqual(['legal-permission']);
  });

  it('ORs repeated values within a facet and ANDs across facets', async () => {
    const db = exploreDb();
    await request(createApp(db, TEST_CONFIG), '/explore?type=throwie&type=piece&city=sf-bay');
    const call = db.matching('m.boards &&')[0];
    expect(call?.params[0]).toEqual(['sf-bay']);
    expect(call?.params[1]).toEqual(['type-throwie', 'type-piece']);
  });

  it('paginates by keyset cursor', async () => {
    const db = exploreDb();
    const cursor = encodeCursor({ createdAt: 1_700_000_000, eventId: FLICK_ID });
    await request(createApp(db, TEST_CONFIG), `/explore?cursor=${cursor}`);
    const call = db.matching('m.boards &&')[0];
    expect(call?.params[5]).toBe(1_700_000_000);
    expect(call?.params[6]).toBe(FLICK_ID);
  });

  it('refuses writes (read-only)', async () => {
    const res = await request(app(), '/explore', { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

describe('GET /crew/:pubkey', () => {
  const crewHeader = (overrides: Record<string, unknown> = {}) => ({
    pubkey: AUTHOR,
    tag_name: 'FASE CREW',
    city: 'sf-bay',
    avatar_sha256: null,
    first_seen: '1700000000',
    updated_at: '1700000000',
    crew_name: 'FASE CREW',
    crew_mark: 'x7k2mq',
    founder_pubkey: hex('ef'),
    founded_at: '1700000000',
    members: [AUTHOR, hex('ef')],
    verified_at: '1700000500',
    verified_by: hex('99'),
    ...overrides,
  });

  it('returns the crew header, roster, repping and a media wall', async () => {
    const db = fakeDb((text) => {
      if (text.includes('from (select $1::text as pk) x')) return { rows: [crewHeader()] };
      if (text.includes('p.crews @> array[$1]')) {
        return { rows: [{ pubkey: hex('ef'), tag_name: 'SMOG', city: 'sf', avatar_sha256: null }] };
      }
      if (text.includes('p.pubkey = any($1::text[])')) {
        return { rows: [{ pubkey: AUTHOR, tag_name: 'FASE CREW', avatar_sha256: null }] };
      }
      if (text.includes('f.pubkey = $1') || text.includes('v.pubkey = $1')) return { rows: [flickRow()] };
      return undefined;
    });
    const res = await request(createApp(db, TEST_CONFIG), `/crew/${AUTHOR}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      crew: { tag: string; mark: string; verified: boolean; memberCount: number; founderPubkey: string };
      members: { pubkey: string; tag: string }[];
      repping: { pubkey: string; tag: string }[];
      flicks: unknown[];
      nextCursor: string | null;
    };
    expect(body.crew.tag).toBe('FASE CREW');
    expect(body.crew.verified).toBe(true);
    expect(body.crew.memberCount).toBe(2);
    expect(body.crew.founderPubkey).toBe(hex('ef'));
    expect(body.members).toHaveLength(2);
    expect(body.members[0]?.pubkey).toBe(AUTHOR);
    expect(body.repping[0]?.tag).toBe('SMOG');
    expect(body.flicks).toHaveLength(1);
  });

  it('shows an unverified crew with no roster when only a profile exists', async () => {
    const db = fakeDb((text) => {
      if (text.includes('from (select $1::text as pk) x')) {
        return {
          rows: [
            crewHeader({
              crew_name: null,
              crew_mark: null,
              founder_pubkey: null,
              founded_at: null,
              members: null,
              verified_at: null,
              verified_by: null,
            }),
          ],
        };
      }
      if (text.includes('f.pubkey = $1') || text.includes('v.pubkey = $1')) return { rows: [flickRow()] };
      return { rows: [] };
    });
    const res = await request(createApp(db, TEST_CONFIG), `/crew/${AUTHOR}`);
    expect(res.status).toBe(200);
    const body = res.body as { crew: { verified: boolean; memberCount: number }; members: unknown[]; repping: unknown[] };
    expect(body.crew.verified).toBe(false);
    expect(body.crew.memberCount).toBe(0);
    expect(body.members).toEqual([]);
    expect(body.repping).toEqual([]);
  });

  it('404s when there is no profile, no definition, no badge and no media', async () => {
    const db = fakeDb((text) => {
      if (text.includes('from (select $1::text as pk) x')) {
        return {
          rows: [
            {
              pubkey: AUTHOR,
              tag_name: null,
              city: null,
              avatar_sha256: null,
              first_seen: null,
              updated_at: null,
              crew_name: null,
              crew_mark: null,
              founder_pubkey: null,
              founded_at: null,
              members: null,
              verified_at: null,
              verified_by: null,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const res = await request(createApp(db, TEST_CONFIG), `/crew/${AUTHOR}`);
    expect(res.status).toBe(404);
  });

  it('400s for a bad pubkey', async () => {
    expect((await request(app(), '/crew/nope')).status).toBe(400);
  });

  it('refuses writes (read-only)', async () => {
    const res = await request(app(), `/crew/${AUTHOR}`, { method: 'DELETE' });
    expect(res.status).toBe(405);
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

  it('also returns videos and threads, without disturbing flicks', async () => {
    const res = await request(app(responder), '/search?q=oakland');
    const body = res.body as {
      flicks: { id: string }[];
      videos: { id: string; mediaType: string; duration: number | null }[];
      threads: { id: string; subject: string; excerpt: string; replyCount: number }[];
    };
    // `flicks` is exactly the field it always was — an older client is fine.
    expect(body.flicks[0]?.id).toBe(FLICK_ID);
    expect(body.videos).toHaveLength(1);
    expect(body.videos[0]).toMatchObject({ mediaType: 'video', duration: 12 });
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]).toMatchObject({
      id: hex('55'),
      subject: 'Who buffed the Alameda wall?',
      replyCount: 3,
    });
  });

  it('answers with empty lists rather than 404 when nothing matches', async () => {
    const res = await request(app(), '/search?q=nothingatall');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ flicks: [], videos: [], threads: [] });
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
