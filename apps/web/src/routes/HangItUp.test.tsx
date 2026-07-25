import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hanging it up.
 *
 * A ceremony with consequences that cannot be undone, so the tests are about
 * the guard rails rather than the layout: the three steps are stated before
 * anything is armed, the button only wakes up for the exact name, the takedown
 * covers what the wall knows AND what this device remembers, the name gets a
 * last word, the crews survive, and an interrupted run can be finished.
 */

/** Every template that reached the miner, in order. */
const mined: { kind: number; tags: string[][]; content: string; created_at: number }[] = [];

vi.mock('../lib/pow.js', () => ({
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

let queryAnswer: { id: string; pubkey: string }[] = [];
let publishAccepts = true;

vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => queryAnswer),
    publish: vi.fn(async () =>
      publishAccepts ? { accepted: true, message: '' } : { accepted: false, message: 'blocked' },
    ),
  } as unknown as (typeof import('../lib/relay.js'))['relay'],
}));

const { HangItUp } = await import('./HangItUp.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { ToastProvider } = await import('../state/ToastProvider.js');
const { createTag, loadTag, rememberOwnPost } = await import('../lib/identity.js');
const { listCrewKeys, saveCrewKey } = await import('../lib/crew-keys.js');
const { pendingRetirement, RETIRE_BATCH, RETIRED_BIO } = await import('../lib/retire.js');
const { resetDbHandle } = await import('../lib/db.js');
const { JARGON_BLOCKLIST, KINDS } = await import('@1nky/protocol');

/** Distinct 64-char hex ids. */
function id(n: number): string {
  return n.toString(16).padStart(64, 'a');
}

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  mined.length = 0;
  queryAnswer = [];
  publishAccepts = true;
  container = document.createElement('div');
  document.body.append(container);
  await createTag('SHOCK');
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

async function settle(rounds = 10): Promise<void> {
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
        <ToastProvider>
          <MemoryRouter initialEntries={['/hang-it-up']}>
            <Routes>
              <Route path="/hang-it-up" element={<HangItUp />} />
              <Route path="/" element={<p>back at the landing</p>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </TagProvider>,
    );
  });
  await settle();
}

function confirmButton(): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Hang it up for good?',
  );
  if (!found) throw new Error('no confirm button');
  return found as HTMLButtonElement;
}

function finishButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === 'Finish the job') as
    | HTMLButtonElement
    | undefined;
}

async function typeName(value: string): Promise<void> {
  const node = container.querySelector('#ritual') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Arm it with the right name and set it going. */
async function run(): Promise<void> {
  await typeName('SHOCK');
  await act(async () => {
    confirmButton().click();
  });
  await settle(16);
}

function buffs(): { tags: string[][] }[] {
  return mined.filter((m) => m.kind === KINDS.DELETE);
}

function buffedIds(): string[] {
  return buffs().flatMap((b) => b.tags.filter((t) => t[0] === 'e').map((t) => t[1]!));
}

describe('hanging it up', () => {
  it('states the three steps before anything is armed', async () => {
    await mount();

    const steps = [...container.querySelectorAll('.ritual-steps > li')].map((li) => li.textContent ?? '');
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain('gets buffed');
    expect(steps[1]).toContain('marked retired');
    expect(steps[2]).toContain('forgets your tag');
  });

  it('says the crews are not part of this', async () => {
    await saveCrewKey({ pubkey: 'c'.repeat(64), secret: new Uint8Array(32).fill(3), name: 'TMD' });

    await mount();

    expect(container.textContent).toContain(
      'Crews you hold stay in your book. Hand them off or burn them separately.',
    );
    expect(container.textContent).toContain('holding 1 of them');
  });

  it('arms only on the exact tag name', async () => {
    await mount();

    expect(confirmButton().disabled).toBe(true);

    await typeName('SHOCKK');
    expect(confirmButton().disabled).toBe(true);

    await typeName('SHOC');
    expect(confirmButton().disabled).toBe(true);

    // Case is not the test — the name is.
    await typeName('shock');
    expect(confirmButton().disabled).toBe(false);
  });

  it('will not start from an empty field', async () => {
    await mount();

    await act(async () => {
      confirmButton().click();
    });
    await settle();

    expect(mined).toHaveLength(0);
    expect(await loadTag()).not.toBeNull();
  });

  it('buffs what the wall knows and what this device remembers, then marks the name', async () => {
    const tag = (await loadTag())!;
    await rememberOwnPost(id(1));
    queryAnswer = [
      { id: id(1), pubkey: tag.pubkey },
      { id: id(2), pubkey: tag.pubkey },
    ];

    await mount();
    await run();

    // Both sources, neither twice.
    expect(new Set(buffedIds())).toEqual(new Set([id(1), id(2)]));
    expect(buffedIds()).toHaveLength(2);

    // The last thing the name says.
    const profile = mined.find((m) => m.kind === KINDS.PROFILE);
    expect(profile).toBeDefined();
    const content = JSON.parse(profile!.content) as Record<string, unknown>;
    expect(content['name']).toBe('SHOCK');
    expect(content['about']).toBe(RETIRED_BIO);
    // Order matters: the work comes down while the tag can still take it down.
    expect(mined.indexOf(profile!)).toBe(mined.length - 1);

    // And the device is empty afterwards.
    expect(await loadTag()).toBeNull();
    expect(container.textContent).toContain('back at the landing');
  });

  it('takes a long history down in batches, counting as it goes', async () => {
    const tag = (await loadTag())!;
    queryAnswer = Array.from({ length: RETIRE_BATCH + 4 }, (_, i) => ({
      id: id(100 + i),
      pubkey: tag.pubkey,
    }));

    // Hold the second batch open so the tally can be read mid-ritual.
    const relayModule = await import('../lib/relay.js');
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    vi.spyOn(relayModule.relay, 'publish').mockImplementation(async () => {
      calls += 1;
      if (calls === 2) await gate;
      return { accepted: true, message: '' };
    });

    await mount();
    await typeName('SHOCK');
    await act(async () => {
      confirmButton().click();
    });
    await settle(6);

    // The tally counts posts, not batches.
    expect(container.textContent).toContain(`Buffing ${RETIRE_BATCH} of ${RETIRE_BATCH + 4}`);

    await act(async () => {
      release();
    });
    await settle(16);

    expect(buffs()).toHaveLength(2);
    expect(buffedIds()).toHaveLength(RETIRE_BATCH + 4);
    expect(await loadTag()).toBeNull();
  });

  it('leaves the tag alone and offers to finish the job when the wall refuses', async () => {
    const tag = (await loadTag())!;
    queryAnswer = [{ id: id(7), pubkey: tag.pubkey }];
    publishAccepts = false;

    await mount();
    await run();

    // Still their tag, nothing pretended otherwise.
    expect(await loadTag()).not.toBeNull();
    expect(container.textContent).toContain('come back and finish the job');
    // What is still up survived on the device.
    expect(await pendingRetirement(tag.pubkey)).toEqual([id(7)]);
  });

  it('offers to finish an interrupted job on the way back in', async () => {
    const tag = (await loadTag())!;
    queryAnswer = [{ id: id(8), pubkey: tag.pubkey }];
    publishAccepts = false;

    await mount();
    await run();

    // Second visit, wall back up.
    act(() => {
      root!.unmount();
    });
    root = null;
    publishAccepts = true;
    mined.length = 0;
    await mount();

    expect(container.textContent).toContain('You started this already');
    expect(container.querySelector('#ritual')).toBeNull();

    await act(async () => {
      finishButton()!.click();
    });
    await settle(16);

    expect(buffedIds()).toEqual([id(8)]);
    expect(mined.some((m) => m.kind === KINDS.PROFILE)).toBe(true);
    expect(await loadTag()).toBeNull();
    expect(await pendingRetirement(tag.pubkey)).toBeNull();
  });

  it('leaves the crew keyring alone', async () => {
    await saveCrewKey({ pubkey: 'c'.repeat(64), secret: new Uint8Array(32).fill(3), name: 'TMD' });

    await mount();
    await run();

    expect(await loadTag()).toBeNull();
    const ring = await listCrewKeys();
    expect(ring).toHaveLength(1);
    expect(ring[0]!.name).toBe('TMD');
  });

  it('says nothing from the jargon blocklist', async () => {
    await saveCrewKey({ pubkey: 'c'.repeat(64), secret: new Uint8Array(32).fill(3), name: 'TMD' });

    await mount();

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
