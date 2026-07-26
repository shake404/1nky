import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Word (`/messages`) can only ever list existing threads today — the owner
 * wants a way to START one right from this screen, pasting a writer's or
 * crew's link the same way the crew founder panel already does. This covers
 * the empty-state CTA, the compact row when threads already exist, and the
 * three lookup states (invalid / not-found / found) using the shared
 * lib/lookup.ts resolver.
 */

// Identicon paints a canvas; happy-dom has no 2D context.
vi.mock('../components/Identicon.js', () => ({
  Identicon: () => null,
}));

// Stop the relay singleton from opening a real WebSocket during the test.
const relayQuery = vi.fn(async (filters: { authors?: string[] }[]) => {
  const author = filters[0]?.authors?.[0];
  if (author === FOUND) {
    return [
      {
        kind: 0,
        pubkey: author,
        created_at: 1,
        content: JSON.stringify({ name: 'FASE' }),
        id: '',
        sig: '',
        tags: [],
      },
    ];
  }
  return [];
});

vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: relayQuery,
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
    subscribe: vi.fn(() => ({ close: vi.fn() })),
  },
}));

const { Messages } = await import('./Messages.js');
const { Conversation } = await import('./Conversation.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { DmProvider } = await import('../state/DmProvider.js');
const { ToastProvider } = await import('../state/ToastProvider.js');
const { createTag } = await import('../lib/identity.js');
const { resetDbHandle, setPref } = await import('../lib/db.js');
const { JARGON_BLOCKLIST } = await import('@1nky/protocol');

const FOUND = 'a'.repeat(64);
const NOBODY = 'c'.repeat(64);

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  relayQuery.mockClear();
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
        <DmProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={['/messages']}>
              <Routes>
                <Route path="/messages" element={<Messages />} />
                <Route path="/messages/:pubkey" element={<Conversation />} />
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </DmProvider>
      </TagProvider>,
    );
  });
  await settle();
}

async function type(placeholder: string, value: string): Promise<void> {
  const node = [...container.querySelectorAll('input')].find(
    (i) => i.placeholder === placeholder,
  ) as HTMLInputElement | undefined;
  if (!node) throw new Error(`no input with placeholder "${placeholder}"`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(label: string): void {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button "${label}"`);
  act(() => {
    found.click();
  });
}

const LOOKUP_PLACEHOLDER = 'https://1nky.com/w/…  or  /w/…  or tag id';

describe('Word — starting a conversation', () => {
  it('shows a Send word CTA in the empty state', async () => {
    await createTag('WRITER');
    await mount();

    expect(container.textContent).toContain('No word yet.');
    expect(container.querySelector('button')?.textContent).toBe('Send word');
  });

  it('opens the inline lookup from the empty state and finds a writer', async () => {
    await createTag('WRITER');
    await mount();

    press('Send word');
    await settle(2);
    await type(LOOKUP_PLACEHOLDER, `https://1nky.com/w/${FOUND}`);
    press('Look up');
    await settle(4);

    const link = container.querySelector(`a[href="/messages/${FOUND}"]`);
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('FASE');

    // Tapping the resolved row lands on the conversation screen.
    await act(async () => {
      (link as HTMLAnchorElement).click();
    });
    await settle(2);
    expect(container.textContent).toContain('Nothing said yet.');
  });

  it('says invalid input plainly rather than asking the wall', async () => {
    await createTag('WRITER');
    await mount();

    press('Send word');
    await settle(2);
    await type(LOOKUP_PLACEHOLDER, 'not a link at all');
    press('Look up');
    await settle(2);

    expect(container.textContent).toContain('That is not a writer or crew.');
  });

  it('says nobody is there when the id parses but nothing has ever posted', async () => {
    await createTag('WRITER');
    await mount();

    press('Send word');
    await settle(2);
    await type(LOOKUP_PLACEHOLDER, NOBODY);
    press('Look up');
    await settle(4);

    expect(container.textContent).toContain('Nobody there yet.');
  });

  it('resolves a crew link the same way as a writer link', async () => {
    await createTag('WRITER');
    await mount();

    press('Send word');
    await settle(2);
    await type(LOOKUP_PLACEHOLDER, `/crew/${FOUND}`);
    press('Look up');
    await settle(4);

    expect(container.querySelector(`a[href="/messages/${FOUND}"]`)).not.toBeNull();
  });

  it('never mind closes the lookup without navigating', async () => {
    await createTag('WRITER');
    await mount();

    press('Send word');
    await settle(2);
    press('Never mind');
    await settle(2);

    expect(container.querySelector('input')).toBeNull();
  });

  it('shows a compact Send word row above the list once threads exist', async () => {
    await createTag('WRITER');
    await setPref('dm-cache', {
      [FOUND]: [
        { key: 'k1', partner: FOUND, senderPubkey: FOUND, text: 'yo', createdAt: 1, mine: false },
      ],
    });
    await mount();

    expect(container.textContent).not.toContain('No word yet.');
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Send word');

    press('Send word');
    await settle(2);
    expect(container.querySelector('input')).not.toBeNull();
  });

  it('says nothing from the jargon blocklist', async () => {
    await createTag('WRITER');
    await mount();

    press('Send word');
    await settle(2);
    await type(LOOKUP_PLACEHOLDER, `/w/${FOUND}`);
    press('Look up');
    await settle(4);

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
