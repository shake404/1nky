import { giftWrapRecipient, KINDS, type SignedEvent } from '@1nky/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "post as crew" active-signer overlay.
 *
 * THE hard rule these tests defend: the single-slot `tag` store (id `'me'`)
 * must never be written by any switcher path. Everything else — actAs, back to
 * me, a missing ring key, re-hydration on reload, and signing a real post as a
 * crew — is checked against that invariant. We spy on the database `put` and
 * assert zero writes to the `tag` store while switching or posting as a crew.
 */

/** Every (secret, pubkey) that reached the miner — proves WHO signed. */
const mined: { secret: Uint8Array; pubkey: string }[] = [];

vi.mock('../lib/pow.js', () => ({
  mineAndSign: vi.fn(
    async (
      template: { kind: number; tags: string[][]; content: string; created_at: number },
      secret: Uint8Array,
      pubkey: string,
    ) => {
      mined.push({ secret: new Uint8Array(secret), pubkey });
      return { ...template, id: `${mined.length}`.padStart(64, '0'), pubkey, sig: '0'.repeat(128) };
    },
  ),
  stopMiner: vi.fn(),
}));

/**
 * Crew-key SYNC is a separate concern (see crew-sync.test.ts): on mount the
 * provider seeds/pulls encrypted crew-key backups, which mine and publish
 * kind-30078 events of their own. That is correct behaviour, but it would put
 * extra entries in `mined` and drown out the one thing these tests measure —
 * WHO signed the post. Stub it out so `mined` holds only the post itself.
 */
vi.mock('../lib/crew-sync.js', () => ({
  backUpCrewKey: vi.fn(async () => undefined),
  ensureCrewBackups: vi.fn(async () => undefined),
  syncCrewKeys: vi.fn(async () => undefined),
}));

/** Everything handed to the relay — gift wraps never go through the miner. */
const published: SignedEvent[] = [];

vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => []),
    subscribe: vi.fn(() => ({ close: vi.fn() })),
    publish: vi.fn(async (event: SignedEvent) => {
      published.push(event);
      return { accepted: true, message: '' };
    }),
  } as unknown as (typeof import('../lib/relay.js'))['relay'],
}));

const { TagProvider, useTag } = await import('./TagProvider.js');
const { createTag, loadTag } = await import('../lib/identity.js');
const { saveCrewKey, removeCrewKey } = await import('../lib/crew-keys.js');
const { getPref, resetDbHandle } = await import('../lib/db.js');
const { buffEvents, postThread } = await import('../lib/publish.js');
const { DmProvider, useDms } = await import('./DmProvider.js');

type Ctx = ReturnType<typeof useTag>;

/** The crew keys we seed into the ring for each test. */
const CREW_A = { pubkey: 'a'.repeat(64), secret: new Uint8Array(32).fill(7), name: 'FASE' };
const CREW_B = { pubkey: 'b'.repeat(64), secret: new Uint8Array(32).fill(9), name: 'KEMZ' };

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;
let api: Ctx | null = null;

/** A probe that hands the live context out to the test on every render. */
function Probe(): null {
  api = useTag();
  return null;
}

let dms: ReturnType<typeof useDms> | null = null;

/** The same, for the message store — only mounted by the messages tests. */
function DmProbe(): null {
  dms = useDms();
  return null;
}

async function mountWithDms(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <TagProvider>
        <Probe />
        <DmProvider>
          <DmProbe />
        </DmProvider>
      </TagProvider>,
    );
  });
  await settle();
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <TagProvider>
        <Probe />
      </TagProvider>,
    );
  });
  await settle();
}

/**
 * Number of writes to the single-slot `tag` store since {@link watchTagStore}.
 *
 * We intercept at `IDBObjectStore.prototype.put` (keyed on the store name)
 * rather than idb's Proxy shorthand, which cannot be spied directly. Every
 * write to the `tag` object store — from anywhere, including deep inside the
 * posting pipeline — passes through here.
 */
let tagWrites = 0;

function watchTagStore(): void {
  tagWrites = 0;
  const proto = IDBObjectStore.prototype as unknown as {
    put: (...args: unknown[]) => unknown;
  };
  const original = proto.put;
  vi.spyOn(proto, 'put').mockImplementation(function (this: IDBObjectStore, ...args: unknown[]) {
    if (this.name === 'tag') tagWrites += 1;
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  });
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  mined.length = 0;
  published.length = 0;
  api = null;
  dms = null;
  container = document.createElement('div');
  document.body.append(container);
  await createTag('ME-WRITER');
  await saveCrewKey(CREW_A);
  await saveCrewKey(CREW_B);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  setActEnv(false);
});

describe('active-signer overlay', () => {
  it('defaults to the writer’s own tag — active IS me', async () => {
    await mount();
    expect(api!.me?.name).toBe('ME-WRITER');
    expect(api!.actingAsCrew).toBeNull();
    expect(api!.active?.pubkey).toBe(api!.me?.pubkey);
    expect(api!.heldCrews).toBeTypeOf('function');
    expect(await api!.heldCrews()).toHaveLength(2);
  });

  it('actAs points the active signer at the crew key from the ring, never touching the tag store', async () => {
    await mount();
    watchTagStore();

    let result = false;
    await act(async () => {
      result = await api!.actAs(CREW_A.pubkey);
    });

    expect(result).toBe(true);
    expect(api!.actingAsCrew).toBe(CREW_A.pubkey);
    expect(api!.active?.pubkey).toBe(CREW_A.pubkey);
    expect(api!.active?.name).toBe('FASE');
    // The secret came straight from the ring.
    expect([...(api!.active!.secret)]).toEqual([...CREW_A.secret]);
    // me is untouched — the persisted identity stays the writer's own tag.
    expect(api!.me?.name).toBe('ME-WRITER');
    // THE hard rule: no write to the `tag` store during a switch.
    expect(tagWrites).toBe(0);
    // The SELECTION (not the secret) is remembered under prefs.
    expect(await getPref<string>('acting-as', 'me')).toBe(CREW_A.pubkey);
  });

  it('back-to-me returns the active signer to the writer’s tag, still not touching the tag store', async () => {
    await mount();
    await act(async () => {
      await api!.actAs(CREW_A.pubkey);
    });

    watchTagStore();

    let result = false;
    await act(async () => {
      result = await api!.actAs(null);
    });

    expect(result).toBe(true);
    expect(api!.actingAsCrew).toBeNull();
    expect(api!.active?.pubkey).toBe(api!.me?.pubkey);
    expect(tagWrites).toBe(0);
    expect(await getPref<string>('acting-as', 'me')).toBe('me');
  });

  it('a missing ring key is a no-op: actAs returns false and active stays me', async () => {
    await mount();
    watchTagStore();

    let result = true;
    await act(async () => {
      result = await api!.actAs('f'.repeat(64));
    });

    expect(result).toBe(false);
    expect(api!.actingAsCrew).toBeNull();
    expect(api!.active?.pubkey).toBe(api!.me?.pubkey);
    expect(tagWrites).toBe(0);
  });

  it('me-tag surfaces still read the writer’s own tag while acting as a crew', async () => {
    await mount();
    await act(async () => {
      await api!.actAs(CREW_A.pubkey);
    });

    // `me` is what settings / blackbook / hang-it-up / restore read — it must
    // remain the writer, not the crew, even mid-session.
    const stored = await loadTag();
    expect(api!.me?.pubkey).toBe(stored?.pubkey);
    expect(api!.me?.name).toBe('ME-WRITER');
    // And the active signer is genuinely the crew, not me.
    expect(api!.active?.pubkey).toBe(CREW_A.pubkey);
    expect(api!.me?.pubkey).not.toBe(api!.active?.pubkey);
  });

  it('verifyActive falls back to me when the crew key vanishes mid-session', async () => {
    await mount();
    await act(async () => {
      await api!.actAs(CREW_A.pubkey);
    });
    expect(api!.actingAsCrew).toBe(CREW_A.pubkey);

    // The key is pulled from the ring (e.g. the crew was handed off / burned).
    await removeCrewKey(CREW_A.pubkey);

    let stillGood = true;
    await act(async () => {
      stillGood = await api!.verifyActive();
    });

    expect(stillGood).toBe(false);
    expect(api!.actingAsCrew).toBeNull();
    expect(api!.active?.pubkey).toBe(api!.me?.pubkey);
  });

  it('re-hydrates the remembered crew on reload — from the ring, never the tag store', async () => {
    await mount();
    await act(async () => {
      await api!.actAs(CREW_B.pubkey);
    });
    expect(api!.actingAsCrew).toBe(CREW_B.pubkey);

    // Reload: tear down and mount fresh against the same durable storage.
    act(() => {
      root!.unmount();
    });
    root = null;
    resetDbHandle();
    await mount();

    expect(api!.actingAsCrew).toBe(CREW_B.pubkey);
    expect(api!.active?.name).toBe('KEMZ');
  });

  it('a remembered crew that is gone by reload falls back to me', async () => {
    await mount();
    await act(async () => {
      await api!.actAs(CREW_B.pubkey);
    });

    await removeCrewKey(CREW_B.pubkey);

    act(() => {
      root!.unmount();
    });
    root = null;
    resetDbHandle();
    await mount();

    expect(api!.actingAsCrew).toBeNull();
    expect(api!.active?.pubkey).toBe(api!.me?.pubkey);
  });

  it('hang-it-up drops the crew overlay and resets the selection to me', async () => {
    await mount();
    await act(async () => {
      await api!.actAs(CREW_A.pubkey);
    });

    await act(async () => {
      await api!.hangItUp();
    });

    expect(api!.me).toBeNull();
    expect(api!.active).toBeNull();
    expect(api!.actingAsCrew).toBeNull();
    expect(await getPref<string>('acting-as', 'me')).toBe('me');
  });
});

describe('posting through the active signer', () => {
  it('a crew post is signed by the crew key and writes NOTHING to the tag store', async () => {
    await mount();
    await act(async () => {
      await api!.actAs(CREW_A.pubkey);
    });

    watchTagStore();

    await act(async () => {
      await postThread(api!.active!, {
        content: 'up on the wall',
        boards: ['sf-bay'],
        // Exactly what the wired surfaces pass when actingAsCrew !== null.
        recordOwn: api!.actingAsCrew === null,
      });
    });

    // Signed by the crew, not the writer.
    expect(mined).toHaveLength(1);
    expect(mined[0]!.pubkey).toBe(CREW_A.pubkey);
    expect([...mined[0]!.secret]).toEqual([...CREW_A.secret]);
    // THE hard rule: a crew post never writes the `tag` store (no markHasPosted).
    expect(tagWrites).toBe(0);
    // And the writer's own tag is unchanged — still a newcomer if it never posted.
    expect((await loadTag())?.hasPosted).toBe(false);
  });

  it('back-to-me posts are signed by the writer’s own tag', async () => {
    await mount();
    await act(async () => {
      await api!.actAs(CREW_A.pubkey);
    });
    await act(async () => {
      await api!.actAs(null);
    });

    await act(async () => {
      await postThread(api!.active!, {
        content: 'my own words',
        boards: ['sf-bay'],
        recordOwn: api!.actingAsCrew === null,
      });
    });

    expect(mined).toHaveLength(1);
    expect(mined[0]!.pubkey).toBe(api!.me!.pubkey);
    expect([...mined[0]!.secret]).toEqual([...api!.me!.secret]);
    // The me path DOES record own-history — that is expected, not a switcher path.
    expect((await loadTag())?.hasPosted).toBe(true);
  });
});

describe('taking your own work down', () => {
  it('treats a crew’s post as yours when the ring holds its key, and hands back the crew signer', async () => {
    await mount();

    const signer = await api!.signerFor(CREW_A.pubkey);

    expect(signer).not.toBeNull();
    expect(signer!.pubkey).toBe(CREW_A.pubkey);
    expect([...signer!.secret]).toEqual([...CREW_A.secret]);
  });

  it('answers for your own tag too, and for nobody else', async () => {
    await mount();

    const meSigner = await api!.signerFor(api!.me!.pubkey);
    expect(meSigner?.pubkey).toBe(api!.me!.pubkey);

    // A writer whose key this device does not hold is not ours to speak for —
    // no signer, so no buff button.
    expect(await api!.signerFor('c'.repeat(64))).toBeNull();
  });

  it('is not the switcher: a crew post stays yours while speaking as your own tag', async () => {
    await mount();
    // Never switched — still posting as ME.
    expect(api!.actingAsCrew).toBeNull();

    // The crew's work is still takeable-down, because the KEY is what decides.
    expect((await api!.signerFor(CREW_A.pubkey))?.pubkey).toBe(CREW_A.pubkey);
  });

  it('buffs a crew post with the CREW key, not the writer’s own tag', async () => {
    await mount();
    const signer = await api!.signerFor(CREW_A.pubkey);

    watchTagStore();
    await act(async () => {
      await buffEvents(signer!, ['f'.repeat(64)], [KINDS.FLICK]);
    });

    // The wall only honours a take-down from the author: it must be the crew.
    expect(mined).toHaveLength(1);
    expect(mined[0]!.pubkey).toBe(CREW_A.pubkey);
    expect([...mined[0]!.secret]).toEqual([...CREW_A.secret]);
    // And taking a crew's post down is still not an event in the writer's own
    // history — nothing reaches the single-slot `tag` store.
    expect(tagWrites).toBe(0);
  });
});

describe('messages always come from your own tag', () => {
  it('signs an outgoing message as ME even while posting as a crew', async () => {
    await mountWithDms();
    await act(async () => {
      await api!.actAs(CREW_A.pubkey);
    });
    // The switcher really is on — this is not a false pass.
    expect(api!.actingAsCrew).toBe(CREW_A.pubkey);

    const partner = 'd'.repeat(64);
    await act(async () => {
      await dms!.send(partner, 'meet at the yard');
    });

    // Two wraps go up: the partner's copy and our own self-copy. `wrapMessage`
    // addresses the self-copy to the SENDER, so its recipient names who signed.
    const recipients = published
      .filter((event) => event.kind === KINDS.GIFT_WRAP)
      .map((event) => giftWrapRecipient(event));

    expect(recipients).toHaveLength(2);
    expect(recipients).toContain(partner);
    // Signed by the writer's own tag...
    expect(recipients).toContain(api!.me!.pubkey);
    // ...and NOT by the crew. A crew-signed message would put its self-copy in
    // the crew's inbox, which this device never listens on — the reply, and our
    // own sent copy, would both be lost while still looking delivered.
    expect(recipients).not.toContain(CREW_A.pubkey);
  });

  it('records the sent message under the writer’s own tag', async () => {
    await mountWithDms();
    await act(async () => {
      await api!.actAs(CREW_A.pubkey);
    });

    const partner = 'd'.repeat(64);
    await act(async () => {
      await dms!.send(partner, 'through the fence');
    });

    const thread = dms!.thread(partner);
    expect(thread).toHaveLength(1);
    expect(thread[0]!.senderPubkey).toBe(api!.me!.pubkey);
    expect(thread[0]!.senderPubkey).not.toBe(CREW_A.pubkey);
  });
});
