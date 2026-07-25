import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { encryptBlackbook, generateSecretKey } from '@1nky/protocol';

import { createApp } from './app.js';
import { UPLOADER_METADATA_KEY } from './config.js';
import { ESCROW_MAX_BYTES, escrowKey } from './escrow.js';
import {
  authHeader,
  makeKeypair,
  MemoryBlobStorage,
  signAuthEvent,
  TEST_CONFIG,
  type TestKeypair,
} from './test-helpers.js';

/** A real NIP-49 payload, with a cheap work factor so tests stay fast. */
function blackbook(passphrase = 'correct horse battery staple'): string {
  return encryptBlackbook(generateSecretKey(), passphrase, { logn: 8 });
}

let storage: MemoryBlobStorage;
let app: Express;
let keys: TestKeypair;

beforeEach(() => {
  storage = new MemoryBlobStorage();
  app = createApp({ storage, config: { ...TEST_CONFIG, escrowEnabled: true } });
  keys = makeKeypair();
});

function escrowAuth(who: TestKeypair = keys) {
  return authHeader(signAuthEvent({ keys: who, verb: 'escrow' }));
}

describe('blackbook escrow', () => {
  it('round-trips PUT → GET → DELETE', async () => {
    const payload = blackbook();

    const put = await request(app)
      .put('/escrow')
      .set('Authorization', escrowAuth())
      .set('Content-Type', 'text/plain')
      .send(payload);
    expect(put.status).toBe(201);
    expect(put.body).toEqual({ stored: true });

    // No auth on the read — a writer who lost their key cannot sign anything.
    const get = await request(app).get(`/escrow/${keys.pubkey}`);
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toContain('text/plain');
    expect(get.headers['cache-control']).toBe('no-store');
    expect(get.text).toBe(payload);

    const del = await request(app).delete('/escrow').set('Authorization', escrowAuth());
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });

    const gone = await request(app).get(`/escrow/${keys.pubkey}`);
    expect(gone.status).toBe(404);
  });

  it('stores only the ciphertext, keyed by the mark under the escrow prefix', async () => {
    const payload = blackbook();
    await request(app).put('/escrow').set('Authorization', escrowAuth()).send(payload);

    expect([...storage.objects.keys()]).toEqual([`escrow/${keys.pubkey}`]);
    const stored = storage.objects.get(escrowKey(keys.pubkey))!;
    expect(stored.body.toString('utf8')).toBe(payload);
    expect(stored.contentType).toBe('text/plain; charset=utf-8');
    expect(stored.cacheControl).toBe('no-store');
    expect(stored.metadata[UPLOADER_METADATA_KEY]).toBe(keys.pubkey);
    // The stored bytes are opaque: an ncryptsec payload and nothing else.
    expect(stored.body.toString('utf8')).toMatch(/^ncryptsec1[0-9a-z]+$/);
  });

  it('overwrites an existing escrow — newer wins — and answers 200 not 201', async () => {
    const first = blackbook('first');
    const second = blackbook('second');
    expect(second).not.toBe(first);

    const a = await request(app).put('/escrow').set('Authorization', escrowAuth()).send(first);
    expect(a.status).toBe(201);

    const b = await request(app).put('/escrow').set('Authorization', escrowAuth()).send(second);
    expect(b.status).toBe(200);

    expect(storage.objects.size).toBe(1);
    const get = await request(app).get(`/escrow/${keys.pubkey}`);
    expect(get.text).toBe(second);
  });

  it('is not reachable through the blob namespace', async () => {
    await request(app).put('/escrow').set('Authorization', escrowAuth()).send(blackbook());
    // The escrow prefix keeps it out of `GET /<64-hex>` even though a mark and a
    // blob address are the same shape.
    const res = await request(app).get(`/${keys.pubkey}`);
    expect(res.status).toBe(404);
  });

  it('401s a PUT with no authorization', async () => {
    const res = await request(app).put('/escrow').send(blackbook());
    expect(res.status).toBe(401);
    expect(storage.objects.size).toBe(0);
  });

  it('401s a PUT whose auth event carries the wrong action', async () => {
    const res = await request(app)
      .put('/escrow')
      .set('Authorization', authHeader(signAuthEvent({ keys, verb: 'upload' })))
      .send(blackbook());
    expect(res.status).toBe(401);
    expect(storage.objects.size).toBe(0);
  });

  it('401s a PUT with a tampered signature', async () => {
    const event = signAuthEvent({ keys, verb: 'escrow' });
    const forged = { ...event, sig: `${'0'.repeat(63)}1`.padEnd(128, 'a') };
    const res = await request(app)
      .put('/escrow')
      .set('Authorization', authHeader(forged))
      .send(blackbook());
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature/i);
    expect(storage.objects.size).toBe(0);
  });

  it('401s an expired auth event', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .put('/escrow')
      .set(
        'Authorization',
        authHeader(
          signAuthEvent({ keys, verb: 'escrow', expiration: nowSec - 10, createdAt: nowSec - 600 }),
        ),
      )
      .send(blackbook());
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('lets a signer touch only their own escrow', async () => {
    const stranger = makeKeypair();
    const mine = blackbook('mine');

    await request(app).put('/escrow').set('Authorization', escrowAuth()).send(mine);
    // The stranger's write lands under the stranger's mark, never over mine.
    await request(app)
      .put('/escrow')
      .set('Authorization', escrowAuth(stranger))
      .send(blackbook('theirs'));

    expect((await request(app).get(`/escrow/${keys.pubkey}`)).text).toBe(mine);

    // …and their delete cannot reach mine either.
    const del = await request(app).delete('/escrow').set('Authorization', escrowAuth(stranger));
    expect(del.status).toBe(200);
    expect((await request(app).get(`/escrow/${keys.pubkey}`)).status).toBe(200);
    expect((await request(app).get(`/escrow/${stranger.pubkey}`)).status).toBe(404);
  });

  it('400s an oversize payload', async () => {
    const big = `ncryptsec1${'a'.repeat(ESCROW_MAX_BYTES)}`;
    const res = await request(app)
      .put('/escrow')
      .set('Authorization', escrowAuth())
      .set('Content-Type', 'text/plain')
      .send(big);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/i);
    expect(storage.objects.size).toBe(0);
  });

  it('400s a body that is not an encrypted blackbook', async () => {
    const res = await request(app)
      .put('/escrow')
      .set('Authorization', escrowAuth())
      .set('Content-Type', 'text/plain')
      .send('nsec1plaintextsecretkeywouldbeadisaster');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/blackbook/i);
    expect(storage.objects.size).toBe(0);
  });

  it('400s an empty body', async () => {
    const res = await request(app)
      .put('/escrow')
      .set('Authorization', escrowAuth())
      .set('Content-Type', 'text/plain')
      .send('');

    expect(res.status).toBe(400);
    expect(storage.objects.size).toBe(0);
  });

  it('400s a GET for something that is not a mark, without touching storage', async () => {
    storage.failWith = 'storage must not be reached';
    const res = await request(app).get('/escrow/not-a-mark');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mark/i);
  });

  it('404s a GET for a mark with nothing escrowed', async () => {
    const other = makeKeypair();
    const res = await request(app).get(`/escrow/${other.pubkey}`);
    expect(res.status).toBe(404);
  });

  it('404s a DELETE when nothing is escrowed', async () => {
    const res = await request(app).delete('/escrow').set('Authorization', escrowAuth());
    expect(res.status).toBe(404);
  });

  it('401s a DELETE with no authorization', async () => {
    await request(app).put('/escrow').set('Authorization', escrowAuth()).send(blackbook());
    const res = await request(app).delete('/escrow');
    expect(res.status).toBe(401);
    expect(storage.objects.size).toBe(1);
  });

  it('accepts an escrow read from any origin', async () => {
    await request(app).put('/escrow').set('Authorization', escrowAuth()).send(blackbook());
    const res = await request(app).get(`/escrow/${keys.pubkey}`);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('blackbook escrow — disabled (default)', () => {
  let dark: Express;

  beforeEach(() => {
    dark = createApp({ storage, config: TEST_CONFIG });
  });

  it('404s PUT /escrow', async () => {
    const res = await request(dark)
      .put('/escrow')
      .set('Authorization', escrowAuth())
      .send(blackbook());
    expect(res.status).toBe(404);
    expect(storage.objects.size).toBe(0);
  });

  it('404s GET /escrow/:pubkey even when a payload exists in the bucket', async () => {
    storage.objects.set(escrowKey(keys.pubkey), {
      key: escrowKey(keys.pubkey),
      body: Buffer.from(blackbook(), 'utf8'),
      contentType: 'text/plain; charset=utf-8',
      cacheControl: 'no-store',
      metadata: {},
    });

    const res = await request(dark).get(`/escrow/${keys.pubkey}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('404s DELETE /escrow', async () => {
    const res = await request(dark).delete('/escrow').set('Authorization', escrowAuth());
    expect(res.status).toBe(404);
  });

  it('never verifies authorization when the feature is off', async () => {
    // A junk token still yields 404, not 401: the route simply does not exist.
    const res = await request(dark)
      .put('/escrow')
      .set('Authorization', 'Nostr not-even-base64-json')
      .send(blackbook());
    expect(res.status).toBe(404);
  });
});

describe('escrow pubkey/payload guards', () => {
  it('rejects a 63-character mark', async () => {
    const res = await request(app).get(`/escrow/${'a'.repeat(63)}`);
    expect(res.status).toBe(400);
  });

  it('accepts an uppercase mark by normalising it', async () => {
    const payload = blackbook();
    await request(app).put('/escrow').set('Authorization', escrowAuth()).send(payload);
    const res = await request(app).get(`/escrow/${keys.pubkey.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.text).toBe(payload);
  });

  it('trims surrounding whitespace off a stored payload', async () => {
    const payload = blackbook();
    await request(app)
      .put('/escrow')
      .set('Authorization', escrowAuth())
      .set('Content-Type', 'text/plain')
      .send(`\n  ${payload}  \n`);

    expect(storage.objects.get(escrowKey(keys.pubkey))!.body.toString('utf8')).toBe(payload);
  });
});
