import type { EventTemplate } from '@1nky/protocol';
import { describe, expect, it, vi } from 'vitest';

/** Every template that was mined, with the difficulty it was mined at. */
const mined: { template: EventTemplate; bits: number }[] = [];
/** Own-post bookkeeping, which a crew's post must never touch. */
const noted: string[] = [];

vi.mock('./pow.js', () => ({
  mineAndSign: vi.fn(async (template: EventTemplate, _secret: Uint8Array, pubkey: string, bits: number) => {
    mined.push({ template, bits });
    return { ...template, id: 'f'.repeat(64), pubkey, sig: '0'.repeat(128) };
  }),
}));

vi.mock('./relay.js', () => ({
  relay: { publish: vi.fn(async () => ({ accepted: true, message: '' })) },
}));

vi.mock('./identity.js', () => ({
  rememberOwnPost: vi.fn(async (id: string) => {
    noted.push(id);
  }),
  markHasPosted: vi.fn(async () => undefined),
}));

const { amendPost, powShortfall } = await import('./publish.js');
const { POW_BITS } = await import('./config.js');
const { KINDS } = await import('@1nky/protocol');

describe('powShortfall', () => {
  it('reads the required difficulty out of a relay pow rejection', () => {
    // The exact shape the write-policy sends after a relay restart forgets you.
    expect(powShortfall('pow: committed difficulty 13 is below the required 18', 13)).toBe(18);
  });

  it('handles the missing-nonce variant naming only the target', () => {
    expect(powShortfall('pow: missing committed difficulty; add a nonce tag targeting 18 bits', 13)).toBe(18);
  });

  it('is null when the ask is not higher than what we tried', () => {
    expect(powShortfall('pow: difficulty 8 does not meet the committed target 8', 13)).toBeNull();
  });

  it('is null for non-pow rejections', () => {
    expect(powShortfall('blocked: this tag is banned', 13)).toBeNull();
    expect(powShortfall('rate limited', 13)).toBeNull();
  });

  it('refuses to chase an absurd difficulty past the ceiling', () => {
    expect(powShortfall('pow: required 99', 13)).toBeNull();
  });

  it('is the gate crew edits + invite mints rely on (publishTemplate path)', () => {
    // The same shortfall the crew-key management events hit after a relay
    // restart. publishTemplate routes through the shared retry, so this number
    // is what saves an "edit crew info" / "put someone on" from bouncing.
    expect(powShortfall('pow: committed difficulty 13 is below the required 18', 13)).toBe(18);
  });
});

describe('amendPost', () => {
  const OWNER = 'a'.repeat(64);
  const target = { id: 'b'.repeat(64), pubkey: OWNER, kind: KINDS.FLICK };
  const owner = {
    pubkey: OWNER,
    secret: new Uint8Array(32).fill(3),
    name: 'SMOG',
    hasPosted: true,
  } as unknown as Parameters<typeof amendPost>[0];

  it('puts up a separate addition at the post tier, not the cheap one', async () => {
    mined.length = 0;
    noted.length = 0;
    await amendPost(owner, target, { boards: ['Oakland'] });

    expect(mined).toHaveLength(1);
    const { template, bits } = mined[0]!;
    expect(template.kind).toBe(KINDS.AMENDMENT);
    expect(template.tags).toContainEqual(['e', target.id, '', OWNER]);
    expect(template.tags).toContainEqual(['t', 'oakland']);
    // An addition can name somebody, so it reaches them: it is priced like a
    // reply, not like a flag. Mined at the reaction tier it would just bounce.
    expect(bits).toBe(POW_BITS.post);
    expect(bits).not.toBe(POW_BITS.reaction);
    expect(noted).toEqual(['f'.repeat(64)]);
  });

  it("keeps a crew's addition out of the device's own-post bookkeeping", async () => {
    mined.length = 0;
    noted.length = 0;
    await amendPost(owner, target, { mentions: ['c'.repeat(64)], recordOwn: false });

    expect(mined[0]?.template.tags).toContainEqual(['p', 'c'.repeat(64), '', 'mention']);
    expect(noted).toEqual([]);
  });

  it('refuses to put up an addition that adds nothing', async () => {
    mined.length = 0;
    await expect(amendPost(owner, target, {})).rejects.toThrow();
    expect(mined).toEqual([]);
  });
});
