import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Starting a thread.
 *
 * The whole point of this screen is the four-way choice about how long it runs,
 * and that choice only exists as a lifetime stamped on what goes up. So this
 * test intercepts the miner and reads the template that was about to be signed:
 * the title, the board it lands on, and whether it carries a lifetime at all.
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
      return { ...template, id: 'f'.repeat(64), pubkey, sig: '0'.repeat(128) };
    },
  ),
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

const { NewThread } = await import('./NewThread.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { ToastProvider } = await import('../state/ToastProvider.js');
const { createTag } = await import('../lib/identity.js');
const { resetDbHandle } = await import('../lib/db.js');
const { BEEF_DURATIONS, JARGON_BLOCKLIST, KINDS } = await import('@1nky/protocol');

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
          <MemoryRouter initialEntries={['/b/sf-bay/new']}>
            <Routes>
              <Route path="/b/:slug/new" element={<NewThread />} />
              <Route path="/t/:id" element={<p>landed on the thread</p>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </TagProvider>,
    );
  });
  await settle();
}

function field(id: string): HTMLTextAreaElement & HTMLInputElement {
  const found = container.querySelector(`#${id}`);
  if (!found) throw new Error(`no field #${id}`);
  return found as HTMLTextAreaElement & HTMLInputElement;
}

/**
 * Type into a controlled field the way React wants to hear about it.
 *
 * Assigning `.value` straight onto the node updates React's own value tracker
 * as a side effect, so React concludes nothing changed and never calls the
 * handler. Going through the prototype setter leaves the tracker alone.
 */
async function type(id: string, value: string): Promise<void> {
  const node = field(id);
  await act(async () => {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Tap one of the four lifetime stickers, matched on its label exactly. */
function pick(label: string): void {
  const found = [...container.querySelectorAll('.beef-pick__option')].find(
    (b) => b.querySelector('.beef-pick__label')?.textContent === label,
  );
  if (!found) throw new Error(`no choice "${label}"`);
  (found as HTMLButtonElement).click();
}

function putItUp(): void {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Put it up');
  if (!found) throw new Error('no put-it-up button');
  found.click();
}

function tagsNamed(name: string): string[][] {
  return (mined[0]?.tags ?? []).filter((t) => t[0] === name);
}

describe('starting a thread', () => {
  it('offers the four lifetimes in the writer’s words', async () => {
    await mount();

    expect(container.textContent).toContain('How long till it dies?');
    for (const label of ['24 hours', '3 days', 'a week', 'pinned']) {
      expect(container.textContent).toContain(label);
    }
    // Four choices, no more — there is no date picker here.
    expect(container.querySelectorAll('.beef-pick__option')).toHaveLength(4);
  });

  it('puts up a thread with the title, the board and a one-day lifetime', async () => {
    await mount();

    await type('thread-subject', 'Who buffed the yard');
    await type('thread-body', 'somebody rolled the whole thing overnight');
    await act(async () => {
      pick('24 hours');
    });

    const before = Math.floor(Date.now() / 1000);
    await act(async () => {
      putItUp();
    });
    await settle();

    expect(mined).toHaveLength(1);
    const template = mined[0]!;
    expect(template.kind).toBe(KINDS.NOTE);
    expect(template.content).toBe('somebody rolled the whole thing overnight');
    expect(tagsNamed('subject')).toEqual([['subject', 'Who buffed the yard']]);
    expect(tagsNamed('t')).toEqual([['t', 'sf-bay']]);

    const lifetime = tagsNamed('expiration')[0]?.[1];
    expect(lifetime).toBeDefined();
    const seconds = Number(lifetime) - before;
    expect(seconds).toBeGreaterThanOrEqual(BEEF_DURATIONS['24h'] - 5);
    expect(seconds).toBeLessThanOrEqual(BEEF_DURATIONS['24h'] + 5);

    // And it drops the writer straight onto the thread they just started.
    expect(container.textContent).toContain('landed on the thread');
  });

  it('stamps a week when a week is chosen', async () => {
    await mount();

    await type('thread-body', 'settle it properly');
    await act(async () => {
      pick('a week');
    });
    const before = Math.floor(Date.now() / 1000);
    await act(async () => {
      putItUp();
    });
    await settle();

    const seconds = Number(tagsNamed('expiration')[0]?.[1]) - before;
    expect(seconds).toBeGreaterThanOrEqual(BEEF_DURATIONS['7d'] - 5);
    expect(seconds).toBeLessThanOrEqual(BEEF_DURATIONS['7d'] + 5);
  });

  it('gives a pinned thread no lifetime at all', async () => {
    await mount();

    await type('thread-body', 'read the rules');
    await act(async () => {
      pick('pinned');
    });
    await act(async () => {
      putItUp();
    });
    await settle();

    expect(mined).toHaveLength(1);
    expect(tagsNamed('expiration')).toEqual([]);
  });

  it('leaves the title off when nobody wrote one', async () => {
    await mount();

    await type('thread-body', 'no title on this one');
    await act(async () => {
      putItUp();
    });
    await settle();

    expect(tagsNamed('subject')).toEqual([]);
  });

  it('slugifies whatever board it was opened on', async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <TagProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={['/b/SF%20Bay/new']}>
              <Routes>
                <Route path="/b/:slug/new" element={<NewThread />} />
                <Route path="/t/:id" element={<p>landed on the thread</p>} />
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </TagProvider>,
      );
    });
    await settle();

    await type('thread-body', 'from a messy slug');
    await act(async () => {
      putItUp();
    });
    await settle();

    expect(tagsNamed('t')).toEqual([['t', 'sf-bay']]);
  });

  it('will not put up an empty thread', async () => {
    await mount();

    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Put it up');
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      putItUp();
    });
    await settle();

    expect(mined).toHaveLength(0);
  });

  it('caps the title and the body', async () => {
    await mount();

    await type('thread-subject', 'x'.repeat(200));
    await type('thread-body', 'y'.repeat(3000));

    expect(field('thread-subject').value).toHaveLength(80);
    expect(field('thread-body').value).toHaveLength(2000);
  });

  it('says nothing from the jargon blocklist', async () => {
    await mount();

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
