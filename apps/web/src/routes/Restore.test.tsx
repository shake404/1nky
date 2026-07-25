import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Getting a tag back through a locked copy.
 *
 * The file is still the front door and is not re-tested here. What is new is the
 * second door, and the thing that matters about it is that it tells the truth
 * about which of three situations somebody is in: the copy is not there, the copy
 * is there and the passphrase is wrong, or the link they pasted was not a link.
 * Those send a person to three different places.
 */

const openLockedCopy = vi.fn(async () => new Uint8Array(32).fill(7));

vi.mock('../lib/recovery.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/recovery.js')>();
  return { ...real, openLockedCopy };
});

vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => []),
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
  } as unknown as (typeof import('../lib/relay.js'))['relay'],
}));

const { Restore } = await import('./Restore.js');
const { NoLockedCopyError } = await import('../lib/recovery.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { loadTag } = await import('../lib/identity.js');
const { resetDbHandle } = await import('../lib/db.js');
const { JARGON_BLOCKLIST } = await import('@1nky/protocol');

const MARK = 'a1'.repeat(32);

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  openLockedCopy.mockClear().mockResolvedValue(new Uint8Array(32).fill(7));
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
        <MemoryRouter initialEntries={['/restore']}>
          <Routes>
            <Route path="/restore" element={<Restore />} />
            <Route path="/" element={<p>back on the wall</p>} />
          </Routes>
        </MemoryRouter>
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

/**
 * Submit the locked-copy form specifically. Both doors have a button reading
 * "Get my tag back", so this one is found through the field only it has.
 */
function submitLockedForm(): void {
  const form = container.querySelector('#lock-handle')?.closest('form');
  if (!form) throw new Error('the locked-copy form is not open');
  const button = [...form.querySelectorAll('button')].find(
    (b) => b.textContent === 'Get my tag back',
  );
  if (!button) throw new Error('no submit on the locked-copy form');
  button.click();
}

/** Open the second door and fill it in. */
async function useLockedCopy(link: string, passphrase = 'a long enough passphrase'): Promise<void> {
  await act(async () => {
    press('Set up recovery earlier?');
  });
  await settle(2);
  await type('lock-handle', link);
  await type('lock-pass', passphrase);
  await act(async () => {
    submitLockedForm();
  });
  await settle();
}

describe('getting a tag back through a locked copy', () => {
  it('keeps the second door closed until it is asked for', async () => {
    await mount();

    expect(container.querySelector('#lock-handle')).toBeNull();
    expect(container.textContent).toContain('Set up recovery earlier?');
  });

  it('opens the copy and adopts the tag', async () => {
    await mount();
    await useLockedCopy(`https://1nky.com/w/${MARK}`);

    expect(openLockedCopy).toHaveBeenCalledWith(MARK, 'a long enough passphrase');
    const stored = await loadTag();
    expect(stored).not.toBeNull();
    // Holding the backup right now counts as having saved it.
    expect(stored?.backedUp).toBe(true);
    expect(container.textContent).toContain('back on the wall');
  });

  it('takes the bare id as well as the whole link', async () => {
    await mount();
    await useLockedCopy(MARK);

    expect(openLockedCopy).toHaveBeenCalledWith(MARK, 'a long enough passphrase');
  });

  it('says it could not read the link rather than asking the wall', async () => {
    await mount();
    await useLockedCopy('my tag, obviously');

    expect(openLockedCopy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Could not make out that link.');
  });

  it('says the passphrase is wrong when it is', async () => {
    openLockedCopy.mockRejectedValueOnce(new Error('Wrong passphrase.'));
    await mount();
    await useLockedCopy(`/w/${MARK}`, 'not the one');

    expect(container.textContent).toContain('Wrong passphrase.');
    expect(await loadTag()).toBeNull();
  });

  it('says there is no copy when there is none', async () => {
    openLockedCopy.mockRejectedValueOnce(new NoLockedCopyError());
    await mount();
    await useLockedCopy(`/w/${MARK}`);

    expect(container.textContent).toContain('No locked copy for that mark.');
    expect(await loadTag()).toBeNull();
  });

  it('says nothing from the jargon blocklist', async () => {
    await mount();
    await act(async () => {
      press('Set up recovery earlier?');
    });
    await settle(2);

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
