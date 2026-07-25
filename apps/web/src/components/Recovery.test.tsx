import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings → Recovery.
 *
 * The words are the feature. Somebody deciding whether to opt in is deciding how
 * much of the "nobody can recover it" promise still holds, so the three sentences
 * that explain the trade are pinned here exactly, and so is the fact that a dark
 * service says "not switched on yet" instead of looking broken.
 */

const putLockedCopy = vi.fn(async (_secret: Uint8Array, _ciphertext: string) => undefined);
const dropLockedCopy = vi.fn(async (_secret: Uint8Array) => undefined);

vi.mock('../lib/recovery.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/recovery.js')>();
  return {
    ...real,
    // The real one is scrypt at the shipped work factor: a second per call, and
    // it is tested on its own in lib/recovery.test.ts.
    lockedCopy: (_secret: Uint8Array, passphrase: string) => {
      if (!passphrase.trim()) throw new Error('Pick a passphrase first.');
      return 'ncryptsec1locked';
    },
    putLockedCopy,
    dropLockedCopy,
  };
});

vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => []),
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
  } as unknown as (typeof import('../lib/relay.js'))['relay'],
}));

const { Recovery } = await import('./Recovery.js');
const { RecoveryDarkError, NoLockedCopyError } = await import('../lib/recovery.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { ToastProvider } = await import('../state/ToastProvider.js');
const { createTag } = await import('../lib/identity.js');
const { resetDbHandle } = await import('../lib/db.js');
const { JARGON_BLOCKLIST } = await import('@1nky/protocol');

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  putLockedCopy.mockClear().mockResolvedValue(undefined);
  dropLockedCopy.mockClear().mockResolvedValue(undefined);
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
            <Recovery />
          </MemoryRouter>
        </ToastProvider>
      </TagProvider>,
    );
  });
  await settle();
}

async function type(id: string, value: string): Promise<void> {
  const node = container.querySelector(`#${id}`) as HTMLInputElement | null;
  if (!node) throw new Error(`no field #${id}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(label: string): void {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button "${label}"`);
  found.click();
}

describe('the recovery section', () => {
  it('says it is optional and does not soften the trade', async () => {
    await mount();

    expect(container.textContent).toContain('Optional.');
    expect(container.textContent).toContain(
      'We keep a locked copy nobody can open — not even us. The passphrase never leaves this device. Lose both the file and the passphrase and the tag is gone, same as always.',
    );
  });

  it('opts in and shows the link to save', async () => {
    await mount();

    await type('recovery-pass', 'a long enough passphrase');
    await type('recovery-pass2', 'a long enough passphrase');
    await act(async () => {
      press('Keep a locked copy');
    });
    await settle();

    expect(putLockedCopy).toHaveBeenCalledTimes(1);
    // What was handed over is the locked payload, not the secret.
    expect(putLockedCopy.mock.calls[0]?.[1]).toBe('ncryptsec1locked');
    expect(container.textContent).toContain(
      'Save this link — it is how you point at the locked copy later.',
    );
    expect(container.querySelector('.panel .mono')?.textContent).toMatch(/\/w\/[0-9a-f]{64}$/);
    // The passphrase fields are cleared once it is done.
    expect((container.querySelector('#recovery-pass') as HTMLInputElement).value).toBe('');
  });

  it('will not opt in on a short passphrase or a mismatch', async () => {
    await mount();

    await type('recovery-pass', 'short');
    await type('recovery-pass2', 'short');
    await act(async () => {
      press('Keep a locked copy');
    });
    await settle();
    expect(container.textContent).toContain('Make it at least 8 characters.');
    expect(putLockedCopy).not.toHaveBeenCalled();

    await type('recovery-pass', 'a long enough passphrase');
    await type('recovery-pass2', 'a different passphrase');
    await act(async () => {
      press('Keep a locked copy');
    });
    await settle();
    expect(container.textContent).toContain('Those do not match.');
    expect(putLockedCopy).not.toHaveBeenCalled();
  });

  it('says the feature is not on yet, and stays on screen', async () => {
    putLockedCopy.mockRejectedValueOnce(new RecoveryDarkError());
    await mount();

    await type('recovery-pass', 'a long enough passphrase');
    await type('recovery-pass2', 'a long enough passphrase');
    await act(async () => {
      press('Keep a locked copy');
    });
    await settle();

    expect(container.textContent).toContain('Recovery is not switched on yet.');
    // Still here, still offering the same thing.
    expect(container.querySelector('#recovery-pass')).not.toBeNull();
    expect(container.textContent).toContain('Recovery');
  });

  it('removes the locked copy when asked', async () => {
    await mount();

    await act(async () => {
      press('Remove the locked copy');
    });
    await settle();

    expect(dropLockedCopy).toHaveBeenCalledTimes(1);
  });

  it('says plainly when there was nothing to remove', async () => {
    dropLockedCopy.mockRejectedValueOnce(new NoLockedCopyError());
    await mount();

    await act(async () => {
      press('Remove the locked copy');
    });
    await settle();

    expect(container.textContent).toContain('No locked copy for that mark.');
  });

  it('says nothing from the jargon blocklist', async () => {
    await mount();

    await type('recovery-pass', 'a long enough passphrase');
    await type('recovery-pass2', 'a long enough passphrase');
    await act(async () => {
      press('Keep a locked copy');
    });
    await settle();

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
