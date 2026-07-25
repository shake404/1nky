import {
  buildCrewKeyBackup,
  decryptCrewKey,
  encryptCrewKey,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  KINDS,
  type CrewKeyPayload,
  type EventTemplate,
  type SignedEvent,
} from '@1nky/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the wire + publish paths before importing crew-sync. The relay's own
// socket never opens in a test; publishTemplate is captured so backUpCrewKey's
// output can be asserted without mining real PoW.
vi.mock('./relay.js', () => ({
  relay: {
    query: vi.fn(async () => [] as SignedEvent[]),
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
    connect: vi.fn(),
  },
}));
vi.mock('./publish.js', () => ({
  publishTemplate: vi.fn(async () => ({ id: 'e'.repeat(64) }) as never),
}));

const { relay } = await import('./relay.js');
const { publishTemplate } = await import('./publish.js');
const { resetDbHandle } = await import('./db.js');
const { backUpCrewKey, ensureCrewBackups, syncCrewKeys } = await import('./crew-sync.js');
const { hasCrewKey, listCrewKeys, saveCrewKey } = await import('./crew-keys.js');
const { loadFoundedCrews } = await import('./crews.js');

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

const owner = generateSecretKey();
const ownerPub = getPublicKey(owner);
const stranger = generateSecretKey();
const strangerPub = getPublicKey(stranger);

const crewSecret = generateSecretKey();
const crewPub = getPublicKey(crewSecret);
const crewSecretHex = hex(crewSecret);

const payload: CrewKeyPayload = { secret: crewSecretHex, name: 'FASE', crewPubkey: crewPub };

/** A real, owner-signed backup event the owner can decrypt. */
function ownBackup(p: CrewKeyPayload): SignedEvent {
  const ciphertext = encryptCrewKey(owner, ownerPub, p);
  return finalizeEvent(buildCrewKeyBackup(ownerPub, p.crewPubkey, ciphertext), owner);
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbHandle();
  vi.mocked(relay.query).mockReset().mockResolvedValue([]);
  vi.mocked(publishTemplate).mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('backUpCrewKey', () => {
  it('publishes a kind-30078 with the crewkey: d-tag and ENCRYPTED content (no plaintext secret)', async () => {
    await backUpCrewKey({ secret: owner, pubkey: ownerPub }, { pubkey: crewPub, secret: crewSecret, name: 'FASE' });

    expect(publishTemplate).toHaveBeenCalledTimes(1);
    const call = vi.mocked(publishTemplate).mock.calls[0]!;
    const [secretArg, pubArg, template] = call as unknown as [Uint8Array, string, EventTemplate];
    expect(pubArg).toBe(ownerPub);
    expect(secretArg).toBe(owner);
    expect(template.kind).toBe(KINDS.APP_DATA);
    expect(template.tags).toContainEqual(['d', `crewkey:${crewPub}`]);

    // The crew secret hex must NEVER appear in the published content.
    expect(template.content).not.toContain(crewSecretHex);
    // But the owner can decrypt it back to the original payload.
    expect(decryptCrewKey(owner, ownerPub, template.content)).toEqual(payload);
  });

  it('never throws even when the publish fails', async () => {
    vi.mocked(publishTemplate).mockRejectedValueOnce(new Error('offline'));
    await expect(
      backUpCrewKey({ secret: owner, pubkey: ownerPub }, { pubkey: crewPub, secret: crewSecret, name: 'FASE' }),
    ).resolves.toBeUndefined();
  });
});

describe('ensureCrewBackups', () => {
  it('backs up a held crew that has none, once, then skips it next time', async () => {
    await saveCrewKey({ pubkey: crewPub, secret: crewSecret, name: 'FASE' });

    const first = await ensureCrewBackups({ secret: owner, pubkey: ownerPub });
    expect(first).toBe(1);
    expect(publishTemplate).toHaveBeenCalledTimes(1);
    // The published backup is a crewkey: kind-30078, encrypted, decryptable by the owner.
    const [, , template] = vi.mocked(publishTemplate).mock.calls[0]! as unknown as [Uint8Array, string, EventTemplate];
    expect(template.tags).toContainEqual(['d', `crewkey:${crewPub}`]);
    expect(template.content).not.toContain(crewSecretHex);
    expect(decryptCrewKey(owner, ownerPub, template.content)).toEqual(payload);

    // Second run: already seeded, nothing new mined.
    vi.mocked(publishTemplate).mockClear();
    const second = await ensureCrewBackups({ secret: owner, pubkey: ownerPub });
    expect(second).toBe(0);
    expect(publishTemplate).not.toHaveBeenCalled();
  });

  it('does nothing when this device holds no crews', async () => {
    expect(await ensureCrewBackups({ secret: owner, pubkey: ownerPub })).toBe(0);
    expect(publishTemplate).not.toHaveBeenCalled();
  });
});

describe('syncCrewKeys', () => {
  it('populates the local ring + founded-crews pointer from a decryptable backup', async () => {
    vi.mocked(relay.query).mockResolvedValue([ownBackup(payload)]);

    const added = await syncCrewKeys({ secret: owner, pubkey: ownerPub });
    expect(added).toBe(1);

    expect(await hasCrewKey(crewPub)).toBe(true);
    const ring = await listCrewKeys();
    expect(ring).toHaveLength(1);
    expect(ring[0]!.pubkey).toBe(crewPub);
    expect(ring[0]!.name).toBe('FASE');
    expect(hex(ring[0]!.secret)).toBe(crewSecretHex);

    expect(await loadFoundedCrews()).toEqual([{ pubkey: crewPub, name: 'FASE', foundedByMe: true }]);
  });

  it('ignores events it cannot decrypt and non-backup events', async () => {
    // Encrypted to a STRANGER, not the owner — the owner cannot open it.
    const foreignCipher = encryptCrewKey(stranger, strangerPub, payload);
    const foreign = finalizeEvent(buildCrewKeyBackup(strangerPub, crewPub, foreignCipher), stranger);
    // A kind-30078 that is not a crew-key backup at all.
    const notBackup = finalizeEvent(
      { kind: KINDS.APP_DATA, tags: [['d', `ban:${crewPub}`]], content: 'x', created_at: 1 },
      owner,
    );
    vi.mocked(relay.query).mockResolvedValue([foreign, notBackup]);

    const added = await syncCrewKeys({ secret: owner, pubkey: ownerPub });
    expect(added).toBe(0);
    expect(await listCrewKeys()).toEqual([]);
  });

  it('is idempotent — a second pull adds nothing and never duplicates', async () => {
    vi.mocked(relay.query).mockResolvedValue([ownBackup(payload)]);

    expect(await syncCrewKeys({ secret: owner, pubkey: ownerPub })).toBe(1);
    expect(await syncCrewKeys({ secret: owner, pubkey: ownerPub })).toBe(0);
    expect(await listCrewKeys()).toHaveLength(1);
  });

  it('returns 0 when the relay query fails', async () => {
    vi.mocked(relay.query).mockRejectedValue(new Error('no socket'));
    expect(await syncCrewKeys({ secret: owner, pubkey: ownerPub })).toBe(0);
  });
});
