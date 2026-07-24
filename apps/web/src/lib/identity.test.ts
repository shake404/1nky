import { fingerprint, getPublicKey } from '@1nky/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbHandle } from './db.js';
import {
  adoptTag,
  createTag,
  exportBlackbook,
  forgetTag,
  importBlackbook,
  loadTag,
  markBackedUp,
  markHasPosted,
  ownPostIds,
  passphraseStrength,
  rememberOwnPost,
  UNLOCKED_WARNING,
} from './identity.js';

// scrypt at the real work factor takes ~1s per call; tests use a cheap one.
const FAST = { logn: 8 };

beforeEach(() => {
  // Fresh database per test so nothing leaks between them.
  globalThis.indexedDB = new IDBFactory();
  resetDbHandle();
});

describe('tag storage', () => {
  it('starts with nothing', async () => {
    expect(await loadTag()).toBeNull();
  });

  it('creates a tag and keeps the secret as raw bytes', async () => {
    const tag = await createTag('  SHOCK  ');

    expect(tag.name).toBe('SHOCK');
    expect(tag.secret).toBeInstanceOf(Uint8Array);
    expect(tag.secret).toHaveLength(32);
    expect(tag.pubkey).toBe(getPublicKey(tag.secret));
    expect(tag.mark).toBe(fingerprint(tag.pubkey));
    expect(tag.backedUp).toBe(false);
    expect(tag.hasPosted).toBe(false);
  });

  it('survives a reload', async () => {
    const created = await createTag('REAK');
    resetDbHandle();

    const loaded = await loadTag();
    expect(loaded).not.toBeNull();
    expect(loaded?.pubkey).toBe(created.pubkey);
    expect([...(loaded?.secret ?? [])]).toEqual([...created.secret]);
  });

  it('refuses an empty tag', async () => {
    await expect(createTag('   ')).rejects.toThrow();
  });

  it('flips the backup and posted flags', async () => {
    await createTag('DEMO');
    expect((await markBackedUp())?.backedUp).toBe(true);
    expect((await markHasPosted())?.hasPosted).toBe(true);
    expect((await loadTag())?.backedUp).toBe(true);
  });

  it('forgets everything on hang-it-up', async () => {
    await createTag('DEMO');
    await rememberOwnPost('a'.repeat(64));
    await forgetTag();

    expect(await loadTag()).toBeNull();
    expect(await ownPostIds()).toEqual([]);
  });

  it('remembers own posts without duplicates', async () => {
    await createTag('DEMO');
    const id = 'b'.repeat(64);
    await rememberOwnPost(id);
    await rememberOwnPost(id);
    expect(await ownPostIds()).toEqual([id]);
  });
});

describe('blackbook round trip', () => {
  it('exports a locked blackbook and reads it back', async () => {
    const tag = await createTag('OMENS');
    const exported = await exportBlackbook(tag, 'correct horse battery', FAST);

    expect(exported.locked).toBe(true);
    expect(exported.filename).toBe('1nky-blackbook-omens.txt');
    expect(exported.payload.startsWith('ncryptsec1')).toBe(true);
    expect(exported.contents).toContain('----- BEGIN BLACKBOOK -----');
    // Hard rule 3: the file a writer reads carries no protocol vocabulary.
    expect(exported.contents.toLowerCase()).not.toContain('nsec');
    expect(exported.contents.toLowerCase()).not.toContain('nostr');

    const recovered = importBlackbook(exported.contents, 'correct horse battery');
    expect([...recovered]).toEqual([...tag.secret]);
  });

  it('restores into a clean device', async () => {
    const original = await createTag('KEMS');
    const exported = await exportBlackbook(original, 'a longer passphrase', FAST);

    // A brand-new device: empty store, only the file.
    globalThis.indexedDB = new IDBFactory();
    resetDbHandle();
    expect(await loadTag()).toBeNull();

    const secret = importBlackbook(exported.contents, 'a longer passphrase');
    const restored = await adoptTag(secret, 'KEMS');

    expect(restored.pubkey).toBe(original.pubkey);
    expect(restored.mark).toBe(original.mark);
    expect(restored.backedUp).toBe(true);
  });

  it('accepts a bare payload as well as the whole file', async () => {
    const tag = await createTag('BARE');
    const exported = await exportBlackbook(tag, 'passphrase here', FAST);
    expect([...importBlackbook(exported.payload, 'passphrase here')]).toEqual([...tag.secret]);
  });

  it('rejects the wrong passphrase', async () => {
    const tag = await createTag('NOPE');
    const exported = await exportBlackbook(tag, 'right one', FAST);
    expect(() => importBlackbook(exported.contents, 'wrong one')).toThrow(/passphrase/i);
  });

  it('rejects junk', async () => {
    expect(() => importBlackbook('a shopping list', '')).toThrow(/not a blackbook/i);
    expect(() => importBlackbook('', '')).toThrow();
  });

  it('round-trips the skip-passphrase path with a loud warning', async () => {
    const tag = await createTag('RISKY');
    const exported = await exportBlackbook(tag, '');

    expect(exported.locked).toBe(false);
    expect(exported.contents).toContain(UNLOCKED_WARNING);
    expect([...importBlackbook(exported.contents, '')]).toEqual([...tag.secret]);
  });
});

describe('passphrase strength', () => {
  it('scores nothing as nothing', () => {
    expect(passphraseStrength('').score).toBe(0);
  });

  it('rewards length over cleverness', () => {
    expect(passphraseStrength('P@1a').score).toBeLessThan(
      passphraseStrength('a fairly long passphrase').score,
    );
  });

  it('tops out at 4', () => {
    expect(passphraseStrength('Correct-Horse-Battery-Staple-99').score).toBe(4);
  });
});
