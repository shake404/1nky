import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Retiring a name, at the level of the machinery.
 *
 * Two things carry the whole feature and neither is visible on the screen: the
 * union of what THIS device remembers with what the wall holds under the tag
 * (either alone leaves work standing), and the leftovers written to the device
 * after every accepted batch (without them, a refusal halfway through strands
 * somebody half-retired).
 */

/** Every template that reached the miner, in order. */
const mined: { kind: number; tags: string[][]; content: string; created_at: number }[] = [];

vi.mock('./pow.js', () => ({
  mineAndSign: vi.fn(
    async (
      template: { kind: number; tags: string[][]; content: string; created_at: number },
      _secret: Uint8Array,
      pubkey: string,
    ) => {
      mined.push(template);
      return { ...template, id: `${mined.length}`.padStart(64, '0'), pubkey, sig: '0'.repeat(128) };
    },
  ),
  stopMiner: vi.fn(),
}));

const queried: unknown[] = [];
let queryAnswer: { id: string; pubkey: string }[] = [];
let publishAccepts = true;

vi.mock('./relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async (filters: unknown) => {
      queried.push(filters);
      return queryAnswer;
    }),
    publish: vi.fn(async () =>
      publishAccepts ? { accepted: true, message: '' } : { accepted: false, message: 'blocked' },
    ),
  } as unknown as (typeof import('./relay.js'))['relay'],
}));

const {
  buffEverything,
  clearPendingRetirement,
  collectOwnIds,
  markRetired,
  pendingRetirement,
  RETIRE_BATCH,
  RETIRE_LOOKBACK,
  RETIRED_BIO,
  RETIRED_KINDS,
} = await import('./retire.js');
const { createTag, rememberOwnPost } = await import('./identity.js');
const { listCrewKeys, saveCrewKey } = await import('./crew-keys.js');
const { resetDbHandle } = await import('./db.js');
const { KINDS } = await import('@1nky/protocol');

/** Distinct 64-char hex ids, so the shape checks are real. */
function id(n: number): string {
  return n.toString(16).padStart(64, 'a');
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbHandle();
  mined.length = 0;
  queried.length = 0;
  queryAnswer = [];
  publishAccepts = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('working out what a tag put up', () => {
  it('unions what this device remembers with what the wall holds', async () => {
    const tag = await createTag('SHOCK');
    await rememberOwnPost(id(1));
    await rememberOwnPost(id(2));
    queryAnswer = [
      { id: id(2), pubkey: tag.pubkey },
      { id: id(3), pubkey: tag.pubkey },
    ];

    const ids = await collectOwnIds(tag.pubkey);

    // Local first, remote after, nothing twice.
    expect(ids).toEqual([id(2), id(1), id(3)]);
  });

  it('asks the wall for every shape of thing a tag can put up', async () => {
    const tag = await createTag('SHOCK');

    await collectOwnIds(tag.pubkey);

    expect(queried).toHaveLength(1);
    const filters = queried[0] as { authors: string[]; kinds: number[]; limit: number }[];
    expect(filters[0]!.authors).toEqual([tag.pubkey]);
    expect(new Set(filters[0]!.kinds)).toEqual(
      new Set([KINDS.PROFILE, KINDS.NOTE, KINDS.FLICK, KINDS.VIDEO, KINDS.COMMENT]),
    );
    expect(filters[0]!.limit).toBe(RETIRE_LOOKBACK);
  });

  it('ignores anything the wall handed back under somebody else’s tag', async () => {
    const tag = await createTag('SHOCK');
    queryAnswer = [
      { id: id(4), pubkey: 'f'.repeat(64) },
      { id: id(5), pubkey: tag.pubkey },
    ];

    expect(await collectOwnIds(tag.pubkey)).toEqual([id(5)]);
  });

  it('still retires on what this device knows when the wall cannot be reached', async () => {
    const tag = await createTag('SHOCK');
    await rememberOwnPost(id(6));
    const relayModule = await import('./relay.js');
    vi.spyOn(relayModule.relay, 'query').mockRejectedValueOnce(new Error('down'));

    expect(await collectOwnIds(tag.pubkey)).toEqual([id(6)]);
  });
});

describe('taking the work down', () => {
  it('buffs in batches rather than one giant takedown', async () => {
    const tag = await createTag('SHOCK');
    const ids = Array.from({ length: RETIRE_BATCH * 2 + 3 }, (_, i) => id(100 + i));

    const seen: { done: number; total: number }[] = [];
    await buffEverything(tag, ids, { onProgress: (p) => seen.push({ ...p }) });

    const buffs = mined.filter((m) => m.kind === KINDS.DELETE);
    expect(buffs).toHaveLength(3);
    expect(buffs[0]!.tags.filter((t) => t[0] === 'e')).toHaveLength(RETIRE_BATCH);
    expect(buffs[2]!.tags.filter((t) => t[0] === 'e')).toHaveLength(3);

    // Every id, exactly once, across the batches.
    const buffed = buffs.flatMap((b) => b.tags.filter((t) => t[0] === 'e').map((t) => t[1]));
    expect(new Set(buffed)).toEqual(new Set(ids));

    // And it names the shapes it is pulling down.
    const kinds = buffs[0]!.tags.filter((t) => t[0] === 'k').map((t) => Number(t[1]));
    expect(new Set(kinds)).toEqual(new Set(RETIRED_KINDS));

    // The tally counts posts, not batches, and ends on the total.
    expect(seen[0]).toEqual({ done: 0, total: ids.length });
    expect(seen.at(-1)).toEqual({ done: ids.length, total: ids.length });
  });

  it('leaves the untouched ids on the device when the wall refuses', async () => {
    const tag = await createTag('SHOCK');
    const ids = Array.from({ length: RETIRE_BATCH + 5 }, (_, i) => id(200 + i));
    publishAccepts = false;

    await expect(buffEverything(tag, ids)).rejects.toThrow();

    // Nothing was accepted, so everything is still standing.
    expect(await pendingRetirement(tag.pubkey)).toEqual(ids);
  });

  it('keeps only what is still up after an accepted batch', async () => {
    const tag = await createTag('SHOCK');
    const ids = Array.from({ length: RETIRE_BATCH + 4 }, (_, i) => id(300 + i));
    const relayModule = await import('./relay.js');
    let calls = 0;
    vi.spyOn(relayModule.relay, 'publish').mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? { accepted: true, message: '' } : { accepted: false, message: 'blocked' };
    });

    await expect(buffEverything(tag, ids)).rejects.toThrow();

    expect(await pendingRetirement(tag.pubkey)).toEqual(ids.slice(RETIRE_BATCH));
  });

  it('finishes with nothing pending when there was nothing to buff', async () => {
    const tag = await createTag('SHOCK');

    await buffEverything(tag, []);

    expect(await pendingRetirement(tag.pubkey)).toEqual([]);
    expect(mined).toHaveLength(0);
  });

  it('tells an unfinished job apart from no job at all', async () => {
    const tag = await createTag('SHOCK');

    expect(await pendingRetirement(tag.pubkey)).toBeNull();
    await clearPendingRetirement();
    expect(await pendingRetirement(tag.pubkey)).toBeNull();
  });

  it('never offers one tag the leftovers of another', async () => {
    const tag = await createTag('SHOCK');
    publishAccepts = false;
    await expect(buffEverything(tag, [id(1)])).rejects.toThrow();

    // Same device, different tag brought back — those ids are not its to buff.
    expect(await pendingRetirement('f'.repeat(64))).toBeNull();
    expect(await pendingRetirement(tag.pubkey)).toEqual([id(1)]);
  });
});

describe('the last thing the name says', () => {
  it('puts up a fresh profile under the same tag, marked retired', async () => {
    const tag = await createTag('SHOCK');

    await markRetired(tag);

    const profile = mined.find((m) => m.kind === KINDS.PROFILE);
    expect(profile).toBeDefined();
    const content = JSON.parse(profile!.content) as Record<string, unknown>;
    expect(content['name']).toBe('SHOCK');
    expect(content['about']).toBe(RETIRED_BIO);
  });
});

describe('crews', () => {
  it('does not touch the crew keyring', async () => {
    const tag = await createTag('SHOCK');
    await saveCrewKey({ pubkey: 'c'.repeat(64), secret: new Uint8Array(32).fill(7), name: 'TMD' });

    await buffEverything(tag, [id(1), id(2)]);
    await markRetired(tag);

    const ring = await listCrewKeys();
    expect(ring).toHaveLength(1);
    expect(ring[0]!.name).toBe('TMD');
  });
});
