import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchCrew, fetchWriterCrews, crewTemplates } from './crews.js';

const crewPubkey = 'a'.repeat(64);
const member = 'b'.repeat(64);
const repper = 'c'.repeat(64);

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

afterEach(() => vi.restoreAllMocks());

describe('fetchCrew shapes the API response', () => {
  it('keeps roster and repping structurally separate', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        crew: {
          pubkey: crewPubkey,
          tag: 'FASE',
          mark: 'aa11bb',
          avatarSha256: null,
          founderPubkey: 'f'.repeat(64),
          foundedAt: 1753000000,
          memberCount: 1,
          verified: true,
          verifiedAt: 1754000000,
        },
        members: [{ pubkey: member, tag: 'SHOCK', mark: 'cc22dd', avatarSha256: null }],
        repping: [{ pubkey: repper, tag: 'TRCK', mark: 'ee33ff', avatarSha256: null }],
        flicks: [],
        nextCursor: null,
      }),
    );

    const page = await fetchCrew(crewPubkey);

    expect(page.crew.tag).toBe('FASE');
    expect(page.crew.verified).toBe(true);
    expect(page.members.map((m) => m.pubkey)).toEqual([member]);
    expect(page.members[0]?.tag).toBe('SHOCK');
    expect(page.repping.map((m) => m.pubkey)).toEqual([repper]);
    expect(page.repping[0]?.tag).toBe('TRCK');
    expect(page.flicks).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.degraded).toBe(false);
  });

  it('falls a missing nested writer down to a fingerprint mark', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        crew: { pubkey: crewPubkey },
        members: [{ pubkey: member }],
        repping: [],
        flicks: [],
        nextCursor: null,
      }),
    );
    const page = await fetchCrew(crewPubkey);
    // Members without an explicit mark still get one from the pubkey.
    expect(page.members[0]?.mark.length).toBeGreaterThanOrEqual(6);
  });
});

describe('fetchWriterCrews', () => {
  it('reads the repping list from the API writer.crews field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ writer: { pubkey: crewPubkey, crews: [crewPubkey, 'z'.repeat(64)] } }),
    );
    const crews = await fetchWriterCrews(crewPubkey);
    expect(crews).toEqual([crewPubkey, 'z'.repeat(64)]);
  });
});

describe('crewTemplates', () => {
  it('builds a kind-0 profile and a kind-30078 definition for a fresh crew', () => {
    const founder = 'f'.repeat(64);
    const { profile, definition } = crewTemplates('FASE', founder, 'mark');
    expect(profile.kind).toBe(0);
    expect(definition.kind).toBe(30078);
    // The roster rides as `p` tags on the definition.
    expect(definition.tags).toContainEqual(['p', founder]);
  });
});