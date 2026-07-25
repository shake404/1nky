import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One thread.
 *
 * The load-bearing part is invisible from the markup: a reply is anchored twice
 * — once at the top of the thread so the whole conversation can be pulled back
 * as one piece, and once at whatever it is actually answering. Get the second
 * one wrong and every reply lands flat at the bottom; get the first one wrong
 * and the reply is orphaned from the thread entirely.
 */

vi.mock('../components/Identicon.js', () => ({ Identicon: () => null }));

vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => []),
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
  } as unknown as (typeof import('../lib/relay.js'))['relay'],
}));

/** Every reply that went up, with the refs it was anchored on. */
const sent: { parent: EventRefLike; root: EventRefLike | undefined; content: string }[] = [];

interface EventRefLike {
  id: string;
  pubkey: string;
  kind: number;
}

vi.mock('../lib/publish.js', () => ({
  postComment: vi.fn(
    async (
      _tag: unknown,
      parent: EventRefLike,
      content: string,
      options: { root?: EventRefLike } = {},
    ) => {
      sent.push({ parent, root: options.root, content });
      return { id: 'e'.repeat(64) };
    },
  ),
}));

const { Thread } = await import('./Thread.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { ToastProvider } = await import('../state/ToastProvider.js');
const { createTag } = await import('../lib/identity.js');
const { resetDbHandle } = await import('../lib/db.js');
const { resetIgnoredCache } = await import('../lib/mute.js');
const { JARGON_BLOCKLIST, KINDS } = await import('@1nky/protocol');

const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
/**
 * The countdown floors, so a lifetime of exactly 4h renders as "3h" the moment
 * the clock ticks past the fixture. Sit clear of the hour boundary.
 */
const CLEAR = 300;

const OP_ID = '1'.repeat(64);
const OP_WRITER = 'a'.repeat(64);
const REPLY_ONE = '2'.repeat(64);
const REPLY_ONE_WRITER = 'b'.repeat(64);
const REPLY_DEEP = '3'.repeat(64);
const REPLY_DEEP_WRITER = 'c'.repeat(64);

function writer(pubkey: string, tag: string): Record<string, unknown> {
  return { pubkey, tag, mark: 'aa11bb', avatarSha256: null };
}

const THREAD = {
  thread: {
    id: OP_ID,
    subject: 'Who buffed the yard',
    content: 'somebody rolled the whole thing overnight',
    boards: ['sf-bay'],
    writer: writer(OP_WRITER, 'SHOCK'),
    createdAt: NOW - 3 * HOUR,
    expiresAt: NOW + 4 * HOUR + CLEAR,
    replyCount: 2,
  },
  comments: [
    {
      id: REPLY_ONE,
      parentId: OP_ID,
      createdAt: NOW - 2 * HOUR,
      content: 'city crew, before sunrise',
      writer: writer(REPLY_ONE_WRITER, 'RASK'),
      replies: [
        {
          id: REPLY_DEEP,
          parentId: REPLY_ONE,
          createdAt: NOW - HOUR,
          content: 'saw the truck myself',
          writer: writer(REPLY_DEEP_WRITER, 'FADE'),
          replies: [],
        },
      ],
    },
  ],
};

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

function threadFetch(body: unknown, ok = true): typeof globalThis.fetch {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 404, json: async () => body }) as Response) as unknown as typeof globalThis.fetch;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  resetIgnoredCache();
  sent.length = 0;
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
          <MemoryRouter initialEntries={[`/t/${OP_ID}`]}>
            <Routes>
              <Route path="/t/:id" element={<Thread />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </TagProvider>,
    );
  });
  await settle();
}

async function type(node: Element, value: string): Promise<void> {
  await act(async () => {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function buttonIn(scope: Element, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!found) throw new Error(`no "${text}" button`);
  return found as HTMLButtonElement;
}

function node(id: string): HTMLElement {
  const found = container.querySelector(`#reply-${id}`);
  if (!found) throw new Error(`no composer under ${id}`);
  return found as HTMLElement;
}

describe('a thread page', () => {
  it('shows the opening post, its countdown, and the board it is on', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(threadFetch(THREAD));

    await mount();

    expect(container.querySelector('h2')?.textContent).toBe('Who buffed the yard');
    expect(container.textContent).toContain('somebody rolled the whole thing overnight');
    expect(container.querySelector('.beef-clock')?.textContent).toBe('dies in 4h');
    // Under six hours: hot.
    expect(container.querySelector('.beef-clock')?.classList.contains('beef-clock--hot')).toBe(true);
    expect(container.querySelector('a[href="/b/sf-bay"]')).not.toBeNull();
  });

  it('nests the replies under what they answer', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(threadFetch(THREAD));

    await mount();

    const top = container.querySelectorAll('.reply');
    // Two replies in the tree, and the deeper one sits inside the first.
    expect(top).toHaveLength(2);

    const outer = [...top].find((li) => li.textContent?.includes('city crew, before sunrise'))!;
    const inner = outer.querySelector('.reply');
    expect(inner).not.toBeNull();
    expect(inner!.textContent).toContain('saw the truck myself');
    expect(outer.getAttribute('data-depth')).toBe('0');
    expect(inner!.getAttribute('data-depth')).toBe('1');
  });

  it('stops indenting once the branch gets deep, without losing the nesting', async () => {
    await createTag('WRITER');
    // Six levels: 0,1,2,3,4 then the sixth pegs at 4.
    let deepest: Record<string, unknown> = {
      id: '9'.repeat(64),
      parentId: null,
      createdAt: NOW,
      content: 'bottom of it',
      writer: writer('f'.repeat(64), 'LAST'),
      replies: [],
    };
    for (let level = 0; level < 5; level += 1) {
      deepest = {
        id: String(level).repeat(64),
        parentId: null,
        createdAt: NOW - level,
        content: `level ${level}`,
        writer: writer('e'.repeat(64), 'DEEP'),
        replies: [deepest],
      };
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      threadFetch({ thread: THREAD.thread, comments: [deepest] }),
    );

    await mount();

    const depths = [...container.querySelectorAll('.reply')].map((li) => li.getAttribute('data-depth'));
    expect(depths).toEqual(['0', '1', '2', '3', '4', '4']);
    expect(container.textContent).toContain('bottom of it');
  });

  it('anchors a reply to the thread itself on the opening post', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(threadFetch(THREAD));

    await mount();

    const box = container.querySelector('#thread-reply')!;
    await type(box, 'they always do');
    await act(async () => {
      buttonIn(container.querySelector('.field:last-of-type')!, 'Put it up').click();
    });
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toBe('they always do');
    expect(sent[0]?.parent).toEqual({ id: OP_ID, pubkey: OP_WRITER, kind: KINDS.NOTE });
    expect(sent[0]?.root).toEqual({ id: OP_ID, pubkey: OP_WRITER, kind: KINDS.NOTE });
  });

  it('anchors a reply to a reply at that reply, with the thread still as the root', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(threadFetch(THREAD));

    await mount();

    // Open the composer under the nested reply, three writers deep.
    const deep = [...container.querySelectorAll('.reply')].find((li) =>
      li.querySelector('.comment__body')?.textContent?.includes('saw the truck myself'),
    )!;
    await act(async () => {
      buttonIn(deep, 'Reply').click();
    });
    await settle(2);

    await type(node(REPLY_DEEP), 'what truck');
    await act(async () => {
      buttonIn(deep, 'Put it up').click();
    });
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toBe('what truck');
    // Parent is the reply being answered — itself a reply, so its own kind.
    expect(sent[0]?.parent).toEqual({
      id: REPLY_DEEP,
      pubkey: REPLY_DEEP_WRITER,
      kind: KINDS.COMMENT,
    });
    // The root never moves off the thread's opening post.
    expect(sent[0]?.root).toEqual({ id: OP_ID, pubkey: OP_WRITER, kind: KINDS.NOTE });
  });

  it('reads the thread again after a reply goes up', async () => {
    await createTag('WRITER');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(threadFetch(THREAD));

    await mount();
    const before = fetchMock.mock.calls.length;

    await type(container.querySelector('#thread-reply')!, 'again');
    await act(async () => {
      buttonIn(container.querySelector('.field:last-of-type')!, 'Put it up').click();
    });
    await settle();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });

  it('says the thread is gone rather than sitting on a blank screen', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(threadFetch({}, false));

    await mount();

    expect(container.textContent).toContain('Gone.');
    expect(container.textContent).toContain('ran out of time');
    expect(container.querySelector('a[href="/boards"]')).not.toBeNull();
  });

  it('says nothing from the jargon blocklist', async () => {
    await createTag('WRITER');
    vi.spyOn(globalThis, 'fetch').mockImplementation(threadFetch(THREAD));

    await mount();

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
