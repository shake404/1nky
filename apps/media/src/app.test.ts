import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Express } from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { UPLOADER_METADATA_KEY } from './config.js';
import { HttpError } from './errors.js';
import {
  authHeader,
  fakeTranscoder,
  makeKeypair,
  MemoryBlobStorage,
  signAuthEvent,
  TEST_CONFIG,
  type TestKeypair,
} from './test-helpers.js';
import type { VideoTranscoder } from './video.js';

function hash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A small solid-colour PNG. */
async function makePng(width = 64, height = 48): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 140, b: 220 } },
  })
    .png()
    .toBuffer();
}

/** A JPEG carrying EXIF, including GPS coordinates in IFD3. */
async function makeJpegWithGpsExif(): Promise<Buffer> {
  return sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 240, g: 60, b: 30 } },
  })
    .jpeg()
    .withExif({
      IFD0: { Copyright: '1nky-test', Make: 'TestCam', Model: 'GPS-Leaker-9000' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '40/1 44/1 5400/100',
        GPSLongitudeRef: 'W',
        GPSLongitude: '73/1 59/1 3600/100',
      },
    })
    .toBuffer();
}

let storage: MemoryBlobStorage;
let app: Express;
let keys: TestKeypair;

beforeEach(() => {
  storage = new MemoryBlobStorage();
  app = createApp({ storage, config: TEST_CONFIG });
  keys = makeKeypair();
});

function uploadAuth(body: Buffer, overrides: Partial<Parameters<typeof signAuthEvent>[0]> = {}) {
  return signAuthEvent({ keys, verb: 'upload', hashes: [hash(body)], ...overrides });
}

describe('PUT /upload', () => {
  it('round-trips a valid upload and returns a descriptor keyed by the post-re-encode hash', async () => {
    const png = await makePng();
    const res = await request(app)
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(png)))
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      type: 'image/webp',
      url: expect.stringContaining('https://media.test/') as unknown as string,
    });
    expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.url).toBe(`https://media.test/${res.body.sha256 as string}`);
    expect(typeof res.body.uploaded).toBe('number');

    // The returned hash is the hash of what we stored, NOT of what was sent.
    const stored = storage.objects.get(res.body.sha256 as string);
    expect(stored).toBeDefined();
    expect(hash(stored!.body)).toBe(res.body.sha256);
    expect(res.body.size).toBe(stored!.body.length);
    expect(res.body.sha256).not.toBe(hash(png));

    expect(stored!.contentType).toBe('image/webp');
    expect(stored!.cacheControl).toBe('public, max-age=31536000, immutable');
    expect(stored!.metadata[UPLOADER_METADATA_KEY]).toBe(keys.pubkey);
    expect((await sharp(stored!.body).metadata()).format).toBe('webp');
  });

  it('returns 200 instead of 201 when the blob already exists', async () => {
    const png = await makePng(32, 32);
    const send = async (): Promise<request.Response> =>
      request(app)
        .put('/upload')
        .set('Authorization', authHeader(uploadAuth(png)))
        .set('Content-Type', 'image/png')
        .send(png);

    const first = await send();
    expect(first.status).toBe(201);
    const second = await send();
    expect(second.status).toBe(200);
    expect(second.body.sha256).toBe(first.body.sha256);
    expect(storage.objects.size).toBe(1);
  });

  it('strips EXIF GPS metadata from an uploaded JPEG', async () => {
    const jpeg = await makeJpegWithGpsExif();

    // Sanity: the input really does carry EXIF.
    const inputMeta = await sharp(jpeg).metadata();
    expect(inputMeta.exif).toBeDefined();
    expect(inputMeta.exif!.length).toBeGreaterThan(0);
    expect(inputMeta.exif!.toString('latin1')).toContain('GPS-Leaker-9000');

    const res = await request(app)
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(jpeg)))
      .set('Content-Type', 'image/jpeg')
      .send(jpeg);

    expect(res.status).toBe(201);

    const stored = storage.objects.get(res.body.sha256 as string)!;
    const outMeta = await sharp(stored.body).metadata();

    expect(outMeta.format).toBe('webp');
    expect(outMeta.exif).toBeUndefined();
    expect(outMeta.icc).toBeUndefined();
    expect(outMeta.iptc).toBeUndefined();
    expect(outMeta.xmp).toBeUndefined();
    expect(outMeta.orientation).toBeUndefined();
    // Belt and braces: no EXIF marker survives anywhere in the stored bytes.
    expect(stored.body.toString('latin1')).not.toContain('GPS-Leaker-9000');
    expect(stored.body.includes(Buffer.from('EXIF', 'ascii'))).toBe(false);
  });

  it('caps stored dimensions at 4096px on the long edge', async () => {
    const wide = await sharp({
      create: { width: 5000, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    const res = await request(app)
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(wide)))
      .set('Content-Type', 'image/png')
      .send(wide);

    expect(res.status).toBe(201);
    const stored = storage.objects.get(res.body.sha256 as string)!;
    const meta = await sharp(stored.body).metadata();
    expect(meta.width).toBe(4096);
    expect(meta.height).toBeLessThanOrEqual(4096);
  });

  it('rejects a tampered signature with 401', async () => {
    const png = await makePng();
    const event = uploadAuth(png);
    const forged = { ...event, sig: `${'0'.repeat(63)}1`.padEnd(128, 'a') };

    const res = await request(app)
      .put('/upload')
      .set('Authorization', authHeader(forged))
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature/i);
    expect(storage.objects.size).toBe(0);
  });

  it('rejects a mutated-content auth event with 401', async () => {
    const png = await makePng();
    const event = uploadAuth(png);
    const mutated = { ...event, content: 'something else entirely' };

    const res = await request(app)
      .put('/upload')
      .set('Authorization', authHeader(mutated))
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(401);
  });

  it('rejects a missing Authorization header with 401', async () => {
    const png = await makePng();
    const res = await request(app).put('/upload').set('Content-Type', 'image/png').send(png);
    expect(res.status).toBe(401);
  });

  it('rejects an expired authorization event with 401', async () => {
    const png = await makePng();
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .put('/upload')
      .set(
        'Authorization',
        authHeader(uploadAuth(png, { expiration: nowSec - 10, createdAt: nowSec - 600 })),
      )
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
    expect(storage.objects.size).toBe(0);
  });

  it('rejects the wrong verb with 401', async () => {
    const png = await makePng();
    const res = await request(app)
      .put('/upload')
      .set(
        'Authorization',
        authHeader(signAuthEvent({ keys, verb: 'delete', hashes: [hash(png)] })),
      )
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(401);
  });

  it('rejects a non-24242 auth event with 401', async () => {
    const png = await makePng();
    const res = await request(app)
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(png, { kind: 27235 })))
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(401);
  });

  it('rejects a body whose hash does not match the x tag with 400', async () => {
    const png = await makePng();
    const other = await makePng(10, 10);

    const res = await request(app)
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(other)))
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/do not match/i);
    expect(storage.objects.size).toBe(0);
  });

  it('rejects an oversize body with 413', async () => {
    const big = Buffer.alloc(TEST_CONFIG.maxUploadBytes + 1024, 7);

    const res = await request(app)
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(big)))
      .set('Content-Type', 'image/webp')
      .send(big);

    expect(res.status).toBe(413);
    expect(storage.objects.size).toBe(0);
  });

  it('rejects a non-image content type with 415', async () => {
    const body = Buffer.from('#!/bin/sh\nrm -rf /\n', 'utf8');

    const res = await request(app)
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(body)))
      .set('Content-Type', 'application/x-sh')
      .send(body);

    expect(res.status).toBe(415);
    expect(storage.objects.size).toBe(0);
  });

  it('rejects bytes sharp cannot decode with 415 even under an image content type', async () => {
    const body = Buffer.from('not really a png, just vibes', 'utf8');

    const res = await request(app)
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(body)))
      .set('Content-Type', 'image/png')
      .send(body);

    expect(res.status).toBe(415);
    expect(storage.objects.size).toBe(0);
  });
});

describe('PUT /upload — video', () => {
  function videoApp(transcoder: VideoTranscoder = fakeTranscoder()): Express {
    return createApp({ storage, config: TEST_CONFIG, transcodeVideo: transcoder });
  }

  function videoBody(size = 2048): Buffer {
    return Buffer.alloc(size, 7);
  }

  it('routes a video content-type through the transcoder and returns a video descriptor', async () => {
    const body = videoBody();
    const res = await request(videoApp())
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(body)))
      .set('Content-Type', 'video/mp4')
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      type: 'video/mp4',
      duration: 12,
      width: 1280,
      height: 720,
      url: expect.stringContaining('https://media.test/') as unknown as string,
    });
    expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.poster).toBeDefined();
    expect(res.body.poster.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.poster.url).toBe(`https://media.test/${res.body.poster.sha256 as string}`);
    expect(res.body.url).toBe(`https://media.test/${res.body.sha256 as string}`);
    expect(typeof res.body.uploaded).toBe('number');
  });

  it('stores the transcoded mp4 and the poster webp with the right content types', async () => {
    const body = videoBody();
    const res = await request(videoApp())
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(body)))
      .set('Content-Type', 'video/quicktime')
      .send(body);

    expect(res.status).toBe(201);
    const video = storage.objects.get(res.body.sha256 as string)!;
    expect(video.contentType).toBe('video/mp4');
    expect(video.cacheControl).toBe('public, max-age=31536000, immutable');
    expect(video.metadata[UPLOADER_METADATA_KEY]).toBe(keys.pubkey);

    const poster = storage.objects.get(res.body.poster.sha256 as string)!;
    expect(poster.contentType).toBe('image/webp');
    expect(poster.cacheControl).toBe('public, max-age=31536000, immutable');
    expect(poster.metadata[UPLOADER_METADATA_KEY]).toBe(keys.pubkey);

    // The descriptor addresses the transcoded bytes, not the raw upload.
    expect(hash(video.body)).toBe(res.body.sha256);
    expect(hash(poster.body)).toBe(res.body.poster.sha256);
  });

  it('routes an image content-type through sharp, never the transcoder', async () => {
    let transcoderCalled = false;
    const spy: VideoTranscoder = async () => {
      transcoderCalled = true;
      return { video: Buffer.alloc(0), poster: Buffer.alloc(0), duration: 1, width: 1, height: 1 };
    };
    const png = await makePng();
    const res = await request(videoApp(spy))
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(png)))
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('image/webp');
    expect(transcoderCalled).toBe(false);
  });

  it('rejects an oversize video body with 413 at the video cap', async () => {
    const big = Buffer.alloc(TEST_CONFIG.maxVideoBytes + 1024, 7);
    const res = await request(videoApp())
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(big)))
      .set('Content-Type', 'video/mp4')
      .send(big);

    expect(res.status).toBe(413);
    expect(storage.objects.size).toBe(0);
  });

  it('returns 415 when the transcoder cannot decode the video', async () => {
    const failing: VideoTranscoder = async () => {
      throw new HttpError(415, 'video could not be decoded');
    };
    const body = videoBody();
    const res = await request(videoApp(failing))
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(body)))
      .set('Content-Type', 'video/webm')
      .send(body);

    expect(res.status).toBe(415);
    expect(storage.objects.size).toBe(0);
  });

  it('rejects a video body whose hash does not match the x tag with 400', async () => {
    const body = videoBody();
    const other = videoBody(4096);
    const res = await request(videoApp())
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(other)))
      .set('Content-Type', 'video/mp4')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/do not match/i);
    expect(storage.objects.size).toBe(0);
  });
});

describe('HEAD /upload (BUD-06)', () => {
  it('accepts a compliant preflight', async () => {
    const res = await request(app)
      .head('/upload')
      .set('X-SHA-256', 'a'.repeat(64))
      .set('X-Content-Type', 'image/webp')
      .set('X-Content-Length', '4096');
    expect(res.status).toBe(200);
  });

  it('rejects an unsupported X-Content-Type with 415 and a reason', async () => {
    const res = await request(app)
      .head('/upload')
      .set('X-Content-Type', 'text/html')
      .set('X-Content-Length', '1024');
    expect(res.status).toBe(415);
    expect(res.headers['x-reason']).toBeDefined();
  });

  it('accepts a video X-Content-Type within the video cap', async () => {
    const res = await request(app)
      .head('/upload')
      .set('X-Content-Type', 'video/mp4')
      .set('X-Content-Length', '1024');
    expect(res.status).toBe(200);
  });

  it('rejects an oversize video X-Content-Length with 413 at the video cap', async () => {
    const res = await request(app)
      .head('/upload')
      .set('X-Content-Type', 'video/mp4')
      .set('X-Content-Length', String(TEST_CONFIG.maxVideoBytes + 1));
    expect(res.status).toBe(413);
  });

  it('rejects an oversize X-Content-Length with 413', async () => {
    const res = await request(app)
      .head('/upload')
      .set('X-Content-Type', 'image/webp')
      .set('X-Content-Length', String(TEST_CONFIG.maxUploadBytes + 1));
    expect(res.status).toBe(413);
  });

  it('rejects a malformed X-SHA-256 with 400', async () => {
    const res = await request(app).head('/upload').set('X-SHA-256', 'nope');
    expect(res.status).toBe(400);
  });
});

describe('GET /:sha256', () => {
  async function seed(): Promise<{ sha256: string; bytes: Buffer }> {
    const png = await makePng();
    const res = await request(app)
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(png)))
      .set('Content-Type', 'image/png')
      .send(png);
    const sha256 = res.body.sha256 as string;
    return { sha256, bytes: storage.objects.get(sha256)!.body };
  }

  it('serves the blob with immutable cache headers and an ETag', async () => {
    const { sha256, bytes } = await seed();

    const res = await request(app).get(`/${sha256}`).responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['etag']).toBe(`"${sha256}"`);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(Buffer.from(res.body as Buffer).equals(bytes)).toBe(true);
  });

  it('serves the blob when the path carries a file extension', async () => {
    const { sha256 } = await seed();
    const res = await request(app).get(`/${sha256}.webp`);
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBe(`"${sha256}"`);
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const { sha256 } = await seed();

    const res = await request(app).get(`/${sha256}`).set('If-None-Match', `"${sha256}"`);

    expect(res.status).toBe(304);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.text).toBeFalsy();
  });

  it('honours a weak If-None-Match', async () => {
    const { sha256 } = await seed();
    const res = await request(app).get(`/${sha256}`).set('If-None-Match', `W/"${sha256}"`);
    expect(res.status).toBe(304);
  });

  it('serves the blob when If-None-Match does not match', async () => {
    const { sha256 } = await seed();
    const res = await request(app).get(`/${sha256}`).set('If-None-Match', `"${'b'.repeat(64)}"`);
    expect(res.status).toBe(200);
  });

  it('404s an unknown blob', async () => {
    const res = await request(app).get(`/${'c'.repeat(64)}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('400s a path that is not a 64-hex sha256, without touching storage', async () => {
    storage.failWith = 'storage must not be reached';
    const res = await request(app).get('/not-a-hash');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hex/i);
  });

  it('400s a 63-character hash', async () => {
    storage.failWith = 'storage must not be reached';
    const res = await request(app).get(`/${'a'.repeat(63)}`);
    expect(res.status).toBe(400);
  });
});

describe('HEAD /:sha256', () => {
  it('returns the same headers with no body', async () => {
    const png = await makePng();
    const upload = await request(app)
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(png)))
      .set('Content-Type', 'image/png')
      .send(png);
    const sha256 = upload.body.sha256 as string;

    const res = await request(app).head(`/${sha256}`);
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBe(`"${sha256}"`);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['content-length']).toBe(String(upload.body.size));
    expect(res.text).toBeFalsy();
  });

  it('404s an unknown blob', async () => {
    const res = await request(app).head(`/${'d'.repeat(64)}`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /:sha256', () => {
  async function seedOwnedBy(owner: TestKeypair): Promise<string> {
    const png = await makePng(24, 24);
    const res = await request(app)
      .put('/upload')
      .set(
        'Authorization',
        authHeader(signAuthEvent({ keys: owner, verb: 'upload', hashes: [hash(png)] })),
      )
      .set('Content-Type', 'image/png')
      .send(png);
    return res.body.sha256 as string;
  }

  it('lets the original uploader delete their blob', async () => {
    const sha256 = await seedOwnedBy(keys);

    const res = await request(app)
      .delete(`/${sha256}`)
      .set('Authorization', authHeader(signAuthEvent({ keys, verb: 'delete', hashes: [sha256] })));

    expect(res.status).toBe(200);
    expect(storage.objects.has(sha256)).toBe(false);
  });

  it('403s a delete signed by anyone but the uploader', async () => {
    const sha256 = await seedOwnedBy(keys);
    const stranger = makeKeypair();

    const res = await request(app)
      .delete(`/${sha256}`)
      .set(
        'Authorization',
        authHeader(signAuthEvent({ keys: stranger, verb: 'delete', hashes: [sha256] })),
      );

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/original uploader/i);
    expect(storage.objects.has(sha256)).toBe(true);
  });

  it('401s when the auth event does not cover the requested blob', async () => {
    const sha256 = await seedOwnedBy(keys);

    const res = await request(app)
      .delete(`/${sha256}`)
      .set(
        'Authorization',
        authHeader(signAuthEvent({ keys, verb: 'delete', hashes: ['e'.repeat(64)] })),
      );

    expect(res.status).toBe(401);
    expect(storage.objects.has(sha256)).toBe(true);
  });

  it('404s an unknown blob', async () => {
    const sha256 = 'f'.repeat(64);
    const res = await request(app)
      .delete(`/${sha256}`)
      .set('Authorization', authHeader(signAuthEvent({ keys, verb: 'delete', hashes: [sha256] })));
    expect(res.status).toBe(404);
  });

  it('400s an invalid path before any auth or storage work', async () => {
    storage.failWith = 'storage must not be reached';
    const res = await request(app).delete('/xyz');
    expect(res.status).toBe(400);
  });
});

describe('CORS', () => {
  it('answers preflight with the Blossom headers', async () => {
    const res = await request(app).options(`/${'a'.repeat(64)}`);
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('PUT');
    expect(res.headers['access-control-allow-methods']).toContain('DELETE');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    expect(res.headers['access-control-expose-headers']).toContain('ETag');
    expect(res.headers['access-control-expose-headers']).toContain('X-Reason');
  });
});

describe('error surface', () => {
  it('returns JSON {error} and an X-Reason header, never echoing request metadata', async () => {
    const res = await request(app)
      .get('/nope')
      .set('X-Forwarded-For', '203.0.113.7')
      .set('User-Agent', 'test-agent/1.0');

    expect(res.status).toBe(400);
    expect(Object.keys(res.body as object)).toEqual(['error']);
    expect(res.headers['x-reason']).toBe(res.body.error);
    expect(JSON.stringify(res.body)).not.toContain('203.0.113.7');
    expect(JSON.stringify(res.body)).not.toContain('test-agent');
  });

  it('hides internal failures behind a generic 500', async () => {
    const png = await makePng();
    storage.failWith = 'bucket exploded';

    const res = await request(app)
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(png)))
      .set('Content-Type', 'image/png')
      .send(png);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal error');
  });
});

// ---------------------------------------------------------------------------
// Real-ffmpeg integration. Gated behind FFMPEG_TESTS=1 so `pnpm test` stays
// green on CI without ffmpeg. When enabled, this builds a tiny clip WITH
// injected metadata, uploads it through the real transcoder, and asserts the
// stored mp4 carries NONE of that metadata and that the duration is capped.
// ---------------------------------------------------------------------------
function ffmpegAvailable(): boolean {
  try {
    const res = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return res.error === undefined && res.status === 0;
  } catch {
    return false;
  }
}

const RUN_FFMPEG = process.env.FFMPEG_TESTS === '1' && ffmpegAvailable();

(RUN_FFMPEG ? describe : describe.skip)('PUT /upload — video ffmpeg integration', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), '1nky-ffmpeg-it-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('transcodes a real clip, strips ALL metadata, caps duration <= 60s', async () => {
    // Build a 2-second clip WITH injected metadata that must be stripped.
    const rawPath = join(dir, 'raw.mp4');
    const makeRaw = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=320x240:rate=10',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-metadata',
        'title=LEAK-METADATA',
        '-metadata',
        'comment=secret-gps-40.7,-74.0',
        rawPath,
      ],
      { stdio: 'ignore' },
    );
    expect(makeRaw.error).toBeUndefined();
    expect(makeRaw.status).toBe(0);

    const raw = readFileSync(rawPath);

    // Sanity: the raw clip really does carry the metadata we expect stripped.
    const rawProbe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_format', '-of', 'json', rawPath],
      { encoding: 'utf8' },
    );
    const rawTags = (JSON.parse(rawProbe.stdout).format?.tags ?? {}) as Record<string, string>;
    expect(JSON.stringify(rawTags)).toContain('LEAK-METADATA');

    const res = await request(app)
      .put('/upload')
      .set('Authorization', authHeader(uploadAuth(raw)))
      .set('Content-Type', 'video/mp4')
      .send(raw);

    expect(res.status).toBe(201);
    expect(res.body.type).toBe('video/mp4');
    expect(res.body.duration).toBeGreaterThan(0);
    expect(res.body.duration).toBeLessThanOrEqual(60);
    expect(res.body.width).toBeLessThanOrEqual(1280);
    expect(res.body.height).toBeLessThanOrEqual(720);

    // The stored mp4 must contain NONE of the injected metadata.
    const stored = storage.objects.get(res.body.sha256 as string)!;
    const storedPath = join(dir, 'stored.mp4');
    writeFileSync(storedPath, stored.body);
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_format', '-of', 'json', storedPath],
      { encoding: 'utf8' },
    );
    const tags = (JSON.parse(probe.stdout).format?.tags ?? {}) as Record<string, string>;
    const blob = JSON.stringify(tags);
    expect(blob).not.toContain('LEAK-METADATA');
    expect(blob).not.toContain('secret-gps');

    // The poster is a webp still with no metadata.
    const poster = storage.objects.get(res.body.poster.sha256 as string)!;
    const posterMeta = await sharp(poster.body).metadata();
    expect(posterMeta.format).toBe('webp');
    expect(posterMeta.exif).toBeUndefined();
  });
});
