import { createHash } from 'node:crypto';

import type { Express } from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { UPLOADER_METADATA_KEY } from './config.js';
import {
  authHeader,
  makeKeypair,
  MemoryBlobStorage,
  signAuthEvent,
  TEST_CONFIG,
  type TestKeypair,
} from './test-helpers.js';

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
      .set('X-Content-Type', 'video/mp4')
      .set('X-Content-Length', '1024');
    expect(res.status).toBe(415);
    expect(res.headers['x-reason']).toBeDefined();
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
