import { createHash } from 'node:crypto';

import type { Express } from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import {
  BlossomMirrorQueue,
  createMirrorQueue,
  type MirrorJob,
  type MirrorOptions,
  type MirrorQueue,
} from './mirror.js';
import {
  authHeader,
  fakeTranscoder,
  makeKeypair,
  MemoryBlobStorage,
  signAuthEvent,
  TEST_CONFIG,
  type TestKeypair,
} from './test-helpers.js';

const MIRROR_URL = 'https://mirror.test';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface FakeFetch {
  readonly impl: typeof fetch;
  readonly calls: Call[];
}

/** Records every request and answers with a scripted sequence of statuses. */
function fakeFetch(statuses: Array<number | 'throw'>): FakeFetch {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    });

    const next = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    if (next === 'throw') throw new Error('connection refused');
    return new Response(null, { status: next });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function queue(statuses: Array<number | 'throw'>, overrides: Partial<MirrorOptions> = {}) {
  const fetcher = fakeFetch(statuses);
  const lines: string[] = [];
  const q = new BlossomMirrorQueue({
    mirrorUrl: MIRROR_URL,
    fetchImpl: fetcher.impl,
    // Backoff is real in production and free here.
    sleep: async () => {},
    log: (line) => lines.push(line),
    ...overrides,
  });
  return { q, calls: fetcher.calls, lines };
}

const JOB: MirrorJob = {
  sha256: 'a'.repeat(64),
  url: `https://media.test/${'a'.repeat(64)}`,
  size: 1234,
  mime: 'image/webp',
};

describe('BlossomMirrorQueue', () => {
  it('PUTs the BUD-04 mirror endpoint with a JSON {url} body', async () => {
    const { q, calls } = queue([200]);
    q.enqueue(JOB);
    await q.idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://mirror.test/mirror');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.body)).toEqual({ url: JOB.url });
    expect(q.stats()).toMatchObject({ enqueued: 1, mirrored: 1, failed: 0, rejected: 0 });
  });

  it('treats any 2xx as mirrored', async () => {
    const { q } = queue([201]);
    q.enqueue(JOB);
    await q.idle();
    expect(q.stats().mirrored).toBe(1);
  });

  it('sends no Authorization header by default', async () => {
    const { q, calls } = queue([200]);
    q.enqueue(JOB);
    await q.idle();
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('forwards an Authorization header when the job carries one', async () => {
    const { q, calls } = queue([200]);
    q.enqueue({ ...JOB, authorization: 'Nostr abc123' });
    await q.idle();
    expect(calls[0]!.headers['authorization']).toBe('Nostr abc123');
  });

  it('retries a 500 and stops after three attempts', async () => {
    const { q, calls, lines } = queue([500]);
    q.enqueue(JOB);
    await q.idle();

    expect(calls).toHaveLength(3);
    expect(q.stats()).toMatchObject({ mirrored: 0, failed: 1 });
    expect(lines).toContain('media-mirror: failed status=500 (failed=1)');
  });

  it('retries a thrown network error and reports no status', async () => {
    const { q, calls, lines } = queue(['throw']);
    q.enqueue(JOB);
    await q.idle();

    expect(calls).toHaveLength(3);
    expect(q.stats().failed).toBe(1);
    expect(lines).toContain('media-mirror: failed status=none (failed=1)');
  });

  it('succeeds on a retry after transient failures', async () => {
    const { q, calls } = queue(['throw', 503, 200]);
    q.enqueue(JOB);
    await q.idle();

    expect(calls).toHaveLength(3);
    expect(q.stats()).toMatchObject({ mirrored: 1, failed: 0 });
  });

  it('drops a 401 immediately without retrying', async () => {
    const { q, calls, lines } = queue([401]);
    q.enqueue(JOB);
    await q.idle();

    expect(calls).toHaveLength(1);
    expect(q.stats()).toMatchObject({ rejected: 1, failed: 0, mirrored: 0 });
    expect(lines).toContain('media-mirror: rejected status=401 (rejected=1)');
  });

  it('drops a 403 immediately without retrying', async () => {
    const { q, calls } = queue([403]);
    q.enqueue(JOB);
    await q.idle();
    expect(calls).toHaveLength(1);
    expect(q.stats().rejected).toBe(1);
  });

  it('drops jobs instead of growing the queue without bound', async () => {
    const { q, lines } = queue([200], { maxQueue: 2, concurrency: 1 });
    for (let i = 0; i < 6; i += 1) q.enqueue(JOB);
    await q.idle();

    expect(q.stats().dropped).toBeGreaterThan(0);
    expect(q.stats().enqueued + q.stats().dropped).toBe(6);
    expect(lines.some((l) => l.startsWith('media-mirror: dropped queue full'))).toBe(true);
  });

  it('honours the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const impl = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const q = new BlossomMirrorQueue({
      mirrorUrl: MIRROR_URL,
      fetchImpl: impl,
      concurrency: 2,
      sleep: async () => {},
      log: () => {},
    });
    for (let i = 0; i < 6; i += 1) q.enqueue(JOB);
    await q.idle();

    expect(peak).toBeLessThanOrEqual(2);
    expect(q.stats().mirrored).toBe(6);
  });

  it('drains everything queued at concurrency 1', async () => {
    const { q, calls } = queue([200], { concurrency: 1, maxQueue: 100 });
    for (let i = 0; i < 5; i += 1) q.enqueue({ ...JOB, url: `https://media.test/blob-${i}` });
    await q.idle();

    expect(calls).toHaveLength(5);
    expect(q.stats().mirrored).toBe(5);
  });

  it('never writes a URL, a content hash or a mark to its log', async () => {
    const { q, lines } = queue(['throw']);
    const mark = 'f'.repeat(64);
    q.enqueue({ ...JOB, authorization: `Nostr ${mark}` });
    await q.idle();

    const log = lines.join('\n');
    expect(log).not.toContain(JOB.sha256);
    expect(log).not.toContain('media.test');
    expect(log).not.toContain('mirror.test');
    expect(log).not.toContain(mark);
    expect(log).toContain('failed=1');
  });

  it('enqueue never throws, even mid-flight', async () => {
    const { q } = queue(['throw']);
    expect(() => q.enqueue(JOB)).not.toThrow();
    await q.idle();
  });

  it('idle() resolves immediately when nothing is queued', async () => {
    const { q } = queue([200]);
    await expect(q.idle()).resolves.toBeUndefined();
  });
});

describe('createMirrorQueue', () => {
  it('returns undefined when no mirror is configured', () => {
    expect(createMirrorQueue({ mirrorUrl: undefined, mirrorConcurrency: 1 })).toBeUndefined();
    expect(createMirrorQueue({ mirrorUrl: '', mirrorConcurrency: 1 })).toBeUndefined();
  });

  it('builds a queue when a mirror is configured', () => {
    const q = createMirrorQueue({ mirrorUrl: MIRROR_URL, mirrorConcurrency: 2 }, { log: () => {} });
    expect(q).toBeInstanceOf(BlossomMirrorQueue);
    expect(q!.stats()).toMatchObject({ enqueued: 0, mirrored: 0 });
  });
});

// ---------------------------------------------------------------------------
// Upload integration: the queue is fed by real uploads, and a dead mirror is
// invisible to the uploading client.
// ---------------------------------------------------------------------------

/** A `MirrorQueue` double that records jobs instead of making requests. */
class RecordingMirror implements MirrorQueue {
  readonly jobs: MirrorJob[] = [];
  throwOnEnqueue = false;

  enqueue(job: MirrorJob): void {
    if (this.throwOnEnqueue) throw new Error('mirror queue exploded');
    this.jobs.push(job);
  }

  stats() {
    return { enqueued: this.jobs.length, mirrored: 0, failed: 0, rejected: 0, dropped: 0 };
  }

  idle(): Promise<void> {
    return Promise.resolve();
  }
}

function hash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function makePng(width = 48, height = 32): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 9, g: 99, b: 199 } },
  })
    .png()
    .toBuffer();
}

let storage: MemoryBlobStorage;
let keys: TestKeypair;

beforeEach(() => {
  storage = new MemoryBlobStorage();
  keys = makeKeypair();
});

function uploadAuth(body: Buffer) {
  return authHeader(signAuthEvent({ keys, verb: 'upload', hashes: [hash(body)] }));
}

describe('upload → mirror wiring', () => {
  it('enqueues the stored image blob after a successful upload', async () => {
    const mirror = new RecordingMirror();
    const app: Express = createApp({ storage, config: TEST_CONFIG, mirror });
    const png = await makePng();

    const res = await request(app)
      .put('/upload')
      .set('Authorization', uploadAuth(png))
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(201);
    expect(mirror.jobs).toHaveLength(1);
    expect(mirror.jobs[0]).toEqual({
      sha256: res.body.sha256,
      url: res.body.url,
      size: res.body.size,
      mime: 'image/webp',
    });
    // The job names the bytes we stored, not the bytes the client sent.
    expect(mirror.jobs[0]!.sha256).not.toBe(hash(png));
  });

  it('enqueues both the mp4 and the poster after a video upload', async () => {
    const mirror = new RecordingMirror();
    const app: Express = createApp({
      storage,
      config: TEST_CONFIG,
      mirror,
      transcodeVideo: fakeTranscoder(),
    });
    const body = Buffer.alloc(2048, 7);

    const res = await request(app)
      .put('/upload')
      .set('Authorization', uploadAuth(body))
      .set('Content-Type', 'video/mp4')
      .send(body);

    expect(res.status).toBe(201);
    expect(mirror.jobs.map((j) => j.mime)).toEqual(['video/mp4', 'image/webp']);
    expect(mirror.jobs[0]!.url).toBe(res.body.url);
    expect(mirror.jobs[1]!.url).toBe(res.body.poster.url);
  });

  it('enqueues nothing when the upload is rejected', async () => {
    const mirror = new RecordingMirror();
    const app: Express = createApp({ storage, config: TEST_CONFIG, mirror });
    const png = await makePng();

    const res = await request(app)
      .put('/upload')
      .set('Authorization', uploadAuth(await makePng(8, 8)))
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(400);
    expect(mirror.jobs).toHaveLength(0);
  });

  it('enqueues nothing when no mirror is configured', async () => {
    const app: Express = createApp({ storage, config: TEST_CONFIG });
    const png = await makePng();
    const res = await request(app)
      .put('/upload')
      .set('Authorization', uploadAuth(png))
      .set('Content-Type', 'image/png')
      .send(png);
    expect(res.status).toBe(201);
  });

  it('succeeds the upload even when the mirror queue itself throws', async () => {
    const mirror = new RecordingMirror();
    mirror.throwOnEnqueue = true;
    const app: Express = createApp({ storage, config: TEST_CONFIG, mirror });
    const png = await makePng();

    const res = await request(app)
      .put('/upload')
      .set('Authorization', uploadAuth(png))
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(201);
    expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.objects.size).toBe(1);
  });

  it('succeeds the upload when the mirror server is down, and gives up quietly', async () => {
    const fetcher = fakeFetch(['throw']);
    const lines: string[] = [];
    const mirror = new BlossomMirrorQueue({
      mirrorUrl: MIRROR_URL,
      fetchImpl: fetcher.impl,
      sleep: async () => {},
      log: (line) => lines.push(line),
    });
    const app: Express = createApp({
      storage,
      config: { ...TEST_CONFIG, mirrorUrl: MIRROR_URL },
      mirror,
    });
    const png = await makePng();

    const res = await request(app)
      .put('/upload')
      .set('Authorization', uploadAuth(png))
      .set('Content-Type', 'image/png')
      .send(png);

    // The client is served normally; the blob is in the primary bucket.
    expect(res.status).toBe(201);
    expect(storage.objects.has(res.body.sha256 as string)).toBe(true);

    await mirror.idle();
    expect(fetcher.calls).toHaveLength(3);
    expect(mirror.stats()).toMatchObject({ mirrored: 0, failed: 1 });
    expect(lines.join('\n')).not.toContain(res.body.sha256);
  });

  it('mirrors the real descriptor URL end-to-end when the mirror is healthy', async () => {
    const fetcher = fakeFetch([200]);
    const mirror = new BlossomMirrorQueue({
      mirrorUrl: MIRROR_URL,
      fetchImpl: fetcher.impl,
      sleep: async () => {},
      log: () => {},
    });
    const app: Express = createApp({ storage, config: TEST_CONFIG, mirror });
    const png = await makePng(64, 64);

    const res = await request(app)
      .put('/upload')
      .set('Authorization', uploadAuth(png))
      .set('Content-Type', 'image/png')
      .send(png);

    await mirror.idle();
    expect(JSON.parse(fetcher.calls[0]!.body)).toEqual({ url: res.body.url });
    expect(mirror.stats().mirrored).toBe(1);
  });
});
