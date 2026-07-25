import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./publish.js', () => ({
  publishProfile: vi.fn(async () => ({ id: 'e'.repeat(64) }) as never),
}));

vi.mock('./profiles.js', () => ({
  fetchProfile: vi.fn(async () => ({ name: 'FOUNDER', bio: 'bits', city: 'SF' }) as never),
  profileTemplate: vi.fn(),
  profileFromEvent: vi.fn(),
}));

// fetchWriterCrews' degrade path queries the relay directly; stub it so a
// failed API read resolves instantly to "no crews" rather than hanging on a
// real socket.
vi.mock('./relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => []),
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
  },
}));

const { publishProfile } = await import('./publish.js');
const { linkCrewToFounder } = await import('./crews.js');

const founderPubkey = 'f'.repeat(64);
const crewPubkey = 'a'.repeat(64);

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.mocked(publishProfile).mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('linkCrewToFounder — the CreateCrew success-path link', () => {
  it('publishes the founder kind-0 with the new crew pubkey appended to crews', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ writer: { pubkey: founderPubkey, crews: [] } }));

    await linkCrewToFounder({ secret: new Uint8Array(32), pubkey: founderPubkey, name: 'FOUNDER' }, crewPubkey);

    expect(publishProfile).toHaveBeenCalledTimes(1);
    const [tagArg, optsArg] = vi.mocked(publishProfile).mock.calls[0]!;
    expect(tagArg!.pubkey).toBe(founderPubkey);
    expect(optsArg!.first).toBe(false);
    expect(optsArg!.crews).toContain(crewPubkey);
  });

  it('merges onto the founder existing crews without dropping the ones already there', async () => {
    const other = 'c'.repeat(64);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ writer: { pubkey: founderPubkey, crews: [other] } }),
    );

    await linkCrewToFounder({ secret: new Uint8Array(32), pubkey: founderPubkey, name: 'FOUNDER' }, crewPubkey);

    expect(publishProfile).toHaveBeenCalledTimes(1);
    const optsArg = vi.mocked(publishProfile).mock.calls[0]![1];
    expect(optsArg!.crews).toEqual([other, crewPubkey]);
  });

  it('skips re-publishing when the founder already reps the crew (dedup)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ writer: { pubkey: founderPubkey, crews: [crewPubkey] } }),
    );

    await linkCrewToFounder({ secret: new Uint8Array(32), pubkey: founderPubkey, name: 'FOUNDER' }, crewPubkey);

    expect(publishProfile).not.toHaveBeenCalled();
  });

  it('tolerates a failed crews read and still links', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    await linkCrewToFounder({ secret: new Uint8Array(32), pubkey: founderPubkey, name: 'FOUNDER' }, crewPubkey);

    expect(publishProfile).toHaveBeenCalledTimes(1);
    const optsArg = vi.mocked(publishProfile).mock.calls[0]![1];
    expect(optsArg!.crews).toEqual([crewPubkey]);
  });
});