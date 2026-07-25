import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stop the relay singleton from opening a real WebSocket during the test.
vi.mock('../lib/relay.js', () => {
  return {
    relay: {
      connect: vi.fn(),
      watch: vi.fn(() => () => {}),
      query: vi.fn(async () => []),
      publish: vi.fn(async () => ({ accepted: true, message: '' })),
    },
  } as unknown as typeof import('../lib/relay.js');
});

// The best-effort profile link mines PoW — stub it so tests stay instant. The
// import must succeed even when the link blows up, which the mock exercises.
vi.mock('../lib/crews.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/crews.js')>();
  return { ...real, linkCrewToFounder: vi.fn(async () => Promise.reject(new Error('offline'))) };
});

const { ImportCrew } = await import('./ImportCrew.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { ToastProvider } = await import('../state/ToastProvider.js');
const { createTag, generateSecretKey, getPublicKey } = await import('../lib/identity.js').then(
  async (identity) => {
    const protocol = await import('@1nky/protocol');
    return { createTag: identity.createTag, generateSecretKey: protocol.generateSecretKey, getPublicKey: protocol.getPublicKey };
  },
);
const { getCrewKey } = await import('../lib/crew-keys.js');
const { loadFoundedCrews } = await import('../lib/crews.js');
const { resetDbHandle } = await import('../lib/db.js');

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ writer: { crews: [] } }),
  } as unknown as Response);
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

async function mount(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <TagProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={['/crew/import']}>
            <ImportCrew />
          </MemoryRouter>
        </ToastProvider>
      </TagProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function setValue(el: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ImportCrew', () => {
  it('imports an unlocked crew blackbook into the keyring and founded list', async () => {
    await createTag('FOUNDER');
    const crewSecret = generateSecretKey();
    const crewPubkey = getPublicKey(crewSecret);

    await mount();

    const textarea = container.querySelector('textarea')!;
    await setValue(textarea, toHex(crewSecret));

    const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Bring it in'))!;
    await act(async () => {
      button.click();
    });
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    const stored = await getCrewKey(crewPubkey);
    expect(stored).toBeDefined();
    expect(toHex(stored!.secret)).toBe(toHex(crewSecret));

    const founded = await loadFoundedCrews();
    expect(founded.some((c) => c.pubkey === crewPubkey)).toBe(true);
  });

  it('rejects garbage with a copy-deck-safe error and stores nothing', async () => {
    await createTag('FOUNDER');
    await mount();

    const textarea = container.querySelector('textarea')!;
    await setValue(textarea, 'this is not a blackbook at all');

    const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Bring it in'))!;
    await act(async () => {
      button.click();
    });
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(container.textContent).toMatch(/that is not a blackbook/i);
    expect(await loadFoundedCrews()).toEqual([]);
  });
});
