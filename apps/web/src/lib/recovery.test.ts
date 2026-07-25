import {
  encryptBlackbook,
  generateSecretKey,
  getPublicKey,
  KINDS,
  verifyEvent,
  type SignedEvent,
} from '@1nky/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRecoveryAuth,
  dropLockedCopy,
  fetchLockedCopy,
  lockedCopy,
  NoLockedCopyError,
  openLockedCopy,
  putLockedCopy,
  recoveryHandle,
  RecoveryDarkError,
} from './recovery.js';

/**
 * The locked copy.
 *
 * One assertion in this file matters more than all the others: the raw secret
 * must not appear in what goes over the wire, in any form. Everything else here
 * is about not lying to a writer — a dark endpoint and a missing record and a
 * wrong passphrase are three different sentences, and reading any of them as
 * another sends somebody looking in the wrong place for a tag they could still
 * get back.
 */

// scrypt at the shipped work factor takes about a second per call. These tests
// only care about what the ciphertext IS, not how expensive it was to make.
const CHEAP = 8;

const SECRET = generateSecretKey();
const PUBKEY = getPublicKey(SECRET);

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Call {
  url: string;
  method: string;
  body: string;
  auth: string;
}

/** Stand in for the media service and remember exactly what it was handed. */
function service(
  answer: (call: Call) => { status: number; body?: string },
): { calls: Call[] } {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
      auth: headers['Authorization'] ?? '',
    };
    calls.push(call);
    const { status, body = '' } = answer(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body || '{}'),
    } as Response;
  }) as unknown as typeof globalThis.fetch);
  return { calls };
}

/** Pull the signed event back out of an `Authorization` header. */
function authEvent(header: string): SignedEvent {
  const encoded = /^Nostr\s+(.+)$/.exec(header)?.[1] ?? '';
  const json = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(json) as SignedEvent;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lockedCopy', () => {
  it('locks the secret and nothing else', () => {
    const payload = lockedCopy(SECRET, 'a long enough passphrase', CHEAP);

    expect(payload.startsWith('ncryptsec1')).toBe(true);
    // The whole promise: the secret is not in there, in any casing.
    expect(payload).not.toContain(hex(SECRET));
    expect(payload.toLowerCase()).not.toContain(hex(SECRET));
  });

  it('refuses to lock with nothing', () => {
    expect(() => lockedCopy(SECRET, '   ', CHEAP)).toThrow('Pick a passphrase first.');
  });
});

describe('buildRecoveryAuth', () => {
  it('asks for the escrow action and expires quickly', () => {
    const now = 1_800_000_000;
    const template = buildRecoveryAuth(now);

    expect(template.kind).toBe(KINDS.BLOSSOM_AUTH);
    expect(template.created_at).toBe(now);
    expect(template.tags[0]).toEqual(['t', 'escrow']);
    expect(template.tags).toContainEqual(['expiration', String(now + 300)]);
    // No blob address is involved: the signer IS the subject.
    expect(template.tags.some((tag) => tag[0] === 'x')).toBe(false);
  });
});

describe('putLockedCopy', () => {
  it('sends the ciphertext, never the secret', async () => {
    const { calls } = service(() => ({ status: 201, body: '{"stored":true}' }));
    const payload = lockedCopy(SECRET, 'a long enough passphrase', CHEAP);

    await putLockedCopy(SECRET, payload);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url).toContain('/escrow');
    expect(call.body).toBe(payload);
    // The load-bearing assertion of this whole feature.
    expect(call.body).not.toContain(hex(SECRET));
    expect(call.body.startsWith('ncryptsec1')).toBe(true);
    // And the passphrase went nowhere either.
    expect(call.body).not.toContain('a long enough passphrase');
  });

  it('proves it is the tag’s own secret asking, with a real signature', async () => {
    const { calls } = service(() => ({ status: 200, body: '{"stored":true}' }));

    await putLockedCopy(SECRET, lockedCopy(SECRET, 'a long enough passphrase', CHEAP));

    const event = authEvent(calls[0]!.auth);
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(KINDS.BLOSSOM_AUTH);
    expect(event.pubkey).toBe(PUBKEY);
    expect(event.tags.find((tag) => tag[0] === 't')).toEqual(['t', 'escrow']);
  });

  it('says the feature is off when the service answers 404', async () => {
    service(() => ({ status: 404 }));

    await expect(
      putLockedCopy(SECRET, lockedCopy(SECRET, 'a long enough passphrase', CHEAP)),
    ).rejects.toThrow('Recovery is not switched on yet.');
    await expect(
      putLockedCopy(SECRET, lockedCopy(SECRET, 'a long enough passphrase', CHEAP)),
    ).rejects.toBeInstanceOf(RecoveryDarkError);
  });

  it('says it did not save on any other refusal', async () => {
    service(() => ({ status: 500 }));

    await expect(
      putLockedCopy(SECRET, lockedCopy(SECRET, 'a long enough passphrase', CHEAP)),
    ).rejects.toThrow('That did not save. Try again.');
  });
});

describe('fetchLockedCopy', () => {
  it('reads the ciphertext back by mark, asking for no proof', async () => {
    const payload = lockedCopy(SECRET, 'a long enough passphrase', CHEAP);
    const { calls } = service(() => ({ status: 200, body: `${payload}\n` }));

    expect(await fetchLockedCopy(PUBKEY)).toBe(payload);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toContain(`/escrow/${PUBKEY}`);
    // Nothing to sign with, so nothing is signed.
    expect(calls[0]!.auth).toBe('');
  });

  it('says there is no locked copy when there is none', async () => {
    service(() => ({ status: 404 }));
    await expect(fetchLockedCopy(PUBKEY)).rejects.toThrow('No locked copy for that mark.');
  });

  it('says the same for a mark that is not one, without asking anybody', async () => {
    const { calls } = service(() => ({ status: 200, body: 'x' }));
    await expect(fetchLockedCopy('not-a-mark')).rejects.toBeInstanceOf(NoLockedCopyError);
    expect(calls).toHaveLength(0);
  });

  it('treats an empty answer as nothing stored', async () => {
    service(() => ({ status: 200, body: '   ' }));
    await expect(fetchLockedCopy(PUBKEY)).rejects.toBeInstanceOf(NoLockedCopyError);
  });

  it('says it could not reach the wall on anything else', async () => {
    service(() => ({ status: 503 }));
    await expect(fetchLockedCopy(PUBKEY)).rejects.toThrow('Could not reach the wall. Try again.');
  });
});

describe('openLockedCopy — the whole way back', () => {
  it('hands back the very same secret it was given', async () => {
    const payload = encryptBlackbook(SECRET, 'a long enough passphrase', { logn: CHEAP });
    service(() => ({ status: 200, body: payload }));

    const recovered = await openLockedCopy(PUBKEY, 'a long enough passphrase');

    expect(hex(recovered)).toBe(hex(SECRET));
    expect(getPublicKey(recovered)).toBe(PUBKEY);
  });

  it('round-trips through a stand-in service that stores what was PUT', async () => {
    let stored = '';
    service((call) => {
      if (call.method === 'PUT') {
        stored = call.body;
        return { status: 201, body: '{"stored":true}' };
      }
      return stored ? { status: 200, body: stored } : { status: 404 };
    });

    await putLockedCopy(SECRET, lockedCopy(SECRET, 'the one I remember', CHEAP));
    const recovered = await openLockedCopy(PUBKEY, 'the one I remember');

    expect(hex(recovered)).toBe(hex(SECRET));
  });

  it('says the passphrase is wrong, not that the copy is missing', async () => {
    const payload = encryptBlackbook(SECRET, 'the right one', { logn: CHEAP });
    service(() => ({ status: 200, body: payload }));

    await expect(openLockedCopy(PUBKEY, 'the wrong one')).rejects.toThrow('Wrong passphrase.');
  });

  it('says the copy is missing, not that the passphrase is wrong', async () => {
    service(() => ({ status: 404 }));

    await expect(openLockedCopy(PUBKEY, 'anything')).rejects.toThrow(
      'No locked copy for that mark.',
    );
  });
});

describe('dropLockedCopy', () => {
  it('asks for it to come down, signed the same way', async () => {
    const { calls } = service(() => ({ status: 200, body: '{"deleted":true}' }));

    await dropLockedCopy(SECRET);

    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toContain('/escrow');
    const event = authEvent(calls[0]!.auth);
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(PUBKEY);
    expect(event.tags.find((tag) => tag[0] === 't')).toEqual(['t', 'escrow']);
    // A delete carries no body at all.
    expect(calls[0]!.body).toBe('');
  });

  it('says there was nothing to remove when the service says 404', async () => {
    service(() => ({ status: 404 }));
    await expect(dropLockedCopy(SECRET)).rejects.toThrow('No locked copy for that mark.');
  });

  it('says it did not come down on anything else', async () => {
    service(() => ({ status: 500 }));
    await expect(dropLockedCopy(SECRET)).rejects.toThrow('That did not come down. Try again.');
  });
});

describe('recoveryHandle', () => {
  it('is the writer’s own profile link and nothing new', () => {
    expect(recoveryHandle(PUBKEY, 'https://1nky.com')).toBe(`https://1nky.com/w/${PUBKEY}`);
    expect(recoveryHandle(PUBKEY.toUpperCase(), 'https://1nky.com/')).toBe(
      `https://1nky.com/w/${PUBKEY}`,
    );
  });

  it('falls back to a bare path when there is no origin to hand', () => {
    expect(recoveryHandle(PUBKEY, '')).toBe(`/w/${PUBKEY}`);
  });
});
