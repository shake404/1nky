import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Getting put on — the handing-out half.
 *
 * Two things are pinned. What goes up: one replaceable app-data thing keyed to
 * a fresh random id, signed by the tag doing the vouching, at the ordinary post
 * tier (the writer handing it out is already on the wall). And what comes back:
 * one string that carries both halves — the id and who vouched — so the person
 * receiving it needs no lookup, plus a local copy so a reload does not lose a
 * string that is already in somebody's hands.
 */

vi.mock('./publish.js', () => ({
  publishTemplate: vi.fn(async () => ({ id: 'e'.repeat(64), created_at: 1_700_000_000 }) as never),
}));

const { publishTemplate } = await import('./publish.js');
const {
  loadMintedPutOns,
  mintPutOn,
  newPutOnId,
  putOnLink,
  putOnTemplate,
  readPutOnCode,
  NOT_A_PUT_ON,
} = await import('./invites.js');
const { resetDbHandle } = await import('./db.js');
const { POW_BITS } = await import('./config.js');
const { decodeInviteCode, KINDS } = await import('@1nky/protocol');

const MY_PUBKEY = 'a'.repeat(64);
const OTHER_PUBKEY = 'b'.repeat(64);
const ME = { secret: new Uint8Array(32), pubkey: MY_PUBKEY };

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbHandle();
  vi.mocked(publishTemplate).mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('putting somebody on — what goes up', () => {
  it('puts up one app-data thing keyed to the fresh id, at the ordinary post tier', async () => {
    const entry = await mintPutOn(ME);

    expect(publishTemplate).toHaveBeenCalledTimes(1);
    const [secret, pubkey, template, bits] = vi.mocked(publishTemplate).mock.calls[0]!;
    expect(pubkey).toBe(MY_PUBKEY);
    expect(secret).toBe(ME.secret);
    expect(bits).toBe(POW_BITS.post);
    expect(template!.kind).toBe(KINDS.APP_DATA);
    expect(template!.kind).toBe(30078);

    const d = template!.tags.find((t) => t[0] === 'd');
    const decoded = decodeInviteCode(entry.code)!;
    expect(decoded).not.toBeNull();
    expect(d).toEqual(['d', `invite:${decoded.inviteId}`]);
    // Nothing about anybody rides in the body — who made it is the signer.
    expect(template!.content).toBe(JSON.stringify({ v: 1 }));
  });

  it('hands back one string carrying both halves: the id and who vouched', async () => {
    const entry = await mintPutOn(ME);

    const decoded = decodeInviteCode(entry.code);
    expect(decoded).not.toBeNull();
    expect(decoded!.inviterPubkey).toBe(MY_PUBKEY);
    expect(decoded!.inviteId).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.code).toBe(`${decoded!.inviteId}.${MY_PUBKEY}`);
  });

  it('keeps it on the device so it can be shown again after a reload', async () => {
    const entry = await mintPutOn(ME);

    const stored = await loadMintedPutOns();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.code).toBe(entry.code);
    expect(stored[0]!.createdAt).toBe(1_700_000_000);
  });

  it('keeps the newest first and never repeats an id', async () => {
    const first = await mintPutOn(ME);
    const second = await mintPutOn(ME);

    expect(second.code).not.toBe(first.code);
    const stored = await loadMintedPutOns();
    expect(stored.map((row) => row.code)).toEqual([second.code, first.code]);
  });

  it('keeps nothing when the wall refused it — a dead string helps nobody', async () => {
    vi.mocked(publishTemplate).mockRejectedValueOnce(new Error('That did not go up. Try again.'));

    await expect(mintPutOn(ME)).rejects.toThrow(/did not go up/i);
    expect(await loadMintedPutOns()).toEqual([]);
  });

  it('mints 32 hex characters of real randomness, never the same twice', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newPutOnId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    // And the id the template is keyed to is the one we were handed.
    const id = newPutOnId();
    expect(putOnTemplate(id).tags).toEqual([['d', `invite:${id}`]]);
  });

  it('builds a link that lands the newcomer on the pick screen', () => {
    const code = `${'1'.repeat(32)}.${OTHER_PUBKEY}`;
    expect(putOnLink(code)).toBe(`https://1nky.com/pick?puton=${code}`);
  });
});

describe('reading one back', () => {
  const code = `${'1'.repeat(32)}.${OTHER_PUBKEY}`;

  it('reads the bare string', () => {
    expect(readPutOnCode(code)).toEqual({ inviteId: '1'.repeat(32), inviterPubkey: OTHER_PUBKEY });
  });

  it('reads it back out of the link somebody was sent', () => {
    expect(readPutOnCode(`https://1nky.com/pick?puton=${code}`)).toEqual({
      inviteId: '1'.repeat(32),
      inviterPubkey: OTHER_PUBKEY,
    });
  });

  it('tolerates the whitespace and case a paste drags in', () => {
    expect(readPutOnCode(`  ${code.toUpperCase()}\n`)).toEqual({
      inviteId: '1'.repeat(32),
      inviterPubkey: OTHER_PUBKEY,
    });
  });

  it('refuses junk, a half string, and a bent one', () => {
    expect(readPutOnCode('')).toBeNull();
    expect(readPutOnCode('not a real thing')).toBeNull();
    expect(readPutOnCode('1'.repeat(32))).toBeNull();
    expect(readPutOnCode(`${'1'.repeat(32)}.${'z'.repeat(64)}`)).toBeNull();
    expect(readPutOnCode(`${'1'.repeat(4)}.${OTHER_PUBKEY}`)).toBeNull();
    expect(readPutOnCode('https://1nky.com/pick?puton=nonsense')).toBeNull();
  });

  it('says one thing about a string that does not read back, in the house voice', () => {
    expect(NOT_A_PUT_ON).toBe("That's not a real put-on.");
    expect(NOT_A_PUT_ON.toLowerCase()).not.toContain('invite');
    expect(NOT_A_PUT_ON.toLowerCase()).not.toContain('code');
  });
});
