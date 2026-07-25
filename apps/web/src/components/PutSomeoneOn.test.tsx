import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Setup section for putting one writer on.
 *
 * Pressing the button has to do exactly one thing: put up the signed app-data
 * thing keyed to a fresh id, at the ordinary post tier, and hand back one
 * string that carries who vouched. The string is then kept on the device, since
 * it is already in somebody's hands and a reload must not lose it.
 */

const mineAndSign = vi.fn(
  async (
    template: { kind: number; tags: string[][]; content: string; created_at: number },
    _secret: Uint8Array,
    pubkey: string,
    _bits: number,
  ) => ({
    ...template,
    id: 'e'.repeat(64),
    pubkey,
    sig: '0'.repeat(128),
  }),
);

vi.mock('../lib/pow.js', () => ({
  mine: vi.fn(),
  mineAndSign,
  stopMiner: vi.fn(),
}));

vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => []),
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
  } as unknown as (typeof import('../lib/relay.js'))['relay'],
}));

const { PutSomeoneOn } = await import('./PutSomeoneOn.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { ToastProvider } = await import('../state/ToastProvider.js');
const { createTag, loadTag } = await import('../lib/identity.js');
const { loadMintedPutOns } = await import('../lib/invites.js');
const { resetDbHandle } = await import('../lib/db.js');
const { POW_BITS } = await import('../lib/config.js');
const { decodeInviteCode, JARGON_BLOCKLIST, KINDS } = await import('@1nky/protocol');

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;
const copied: string[] = [];

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  mineAndSign.mockClear();
  copied.length = 0;
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
    configurable: true,
  });
  container = document.createElement('div');
  document.body.append(container);
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
        <ToastProvider>
          <MemoryRouter>
            <PutSomeoneOn />
          </MemoryRouter>
        </ToastProvider>
      </TagProvider>,
    );
  });
  await settle();
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

async function press(label: string): Promise<void> {
  const target = button(label);
  await act(async () => {
    target.click();
  });
  await settle();
}

describe('put someone on', () => {
  it('puts up the right thing: app-data, keyed to a fresh id, at the post tier', async () => {
    await createTag('SHOCK');
    await mount();

    await press('Put someone on');

    expect(mineAndSign).toHaveBeenCalledTimes(1);
    const [template, , pubkey, bits] = mineAndSign.mock.calls[0]!;
    expect(template.content).toBe(JSON.stringify({ v: 1 }));
    const me = (await loadTag())!;
    expect(pubkey).toBe(me.pubkey);
    expect(bits).toBe(POW_BITS.post);
    expect(template.kind).toBe(KINDS.APP_DATA);
    expect(template.kind).toBe(30078);

    const d = template.tags.find((t) => t[0] === 'd')!;
    expect(d[1]).toMatch(/^invite:[0-9a-f]{32}$/);
  });

  it('shows the string it made and keeps it on the device', async () => {
    await createTag('SHOCK');
    await mount();

    await press('Put someone on');

    const stored = await loadMintedPutOns();
    expect(stored).toHaveLength(1);
    const entry = stored[0]!;
    const decoded = decodeInviteCode(entry.code)!;
    expect(decoded.inviterPubkey).toBe((await loadTag())!.pubkey);
    // The `d` tag on what went up and the string handed over are the same id.
    expect(mineAndSign.mock.calls[0]![0].tags).toContainEqual(['d', `invite:${decoded.inviteId}`]);

    expect(container.textContent).toContain(entry.code);
    expect(container.textContent).toContain('Hand this to one writer');
    expect(container.textContent).toContain(`https://1nky.com/pick?puton=${entry.code}`);
  });

  it('copies the string, and the link, on request', async () => {
    await createTag('SHOCK');
    await mount();
    await press('Put someone on');
    const code = (await loadMintedPutOns())[0]!.code;

    await press('Copy it');
    expect(copied).toEqual([code]);

    await press('Copy the link');
    expect(copied[1]).toBe(`https://1nky.com/pick?puton=${code}`);
  });

  it('shows one already handed out when the screen comes back', async () => {
    await createTag('SHOCK');
    await mount();
    await press('Put someone on');
    const code = (await loadMintedPutOns())[0]!.code;

    act(() => {
      root!.unmount();
    });
    root = null;
    await mount();

    expect(container.textContent).toContain(code);
    // And nothing new went up just by looking at it.
    expect(mineAndSign).toHaveBeenCalledTimes(1);
  });

  it('says nothing from the jargon blocklist, and never calls it a code', async () => {
    await createTag('SHOCK');
    await mount();
    await press('Put someone on');

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
    expect(words).not.toContain('invite');
    expect(words).not.toContain(' code');
  });
});
