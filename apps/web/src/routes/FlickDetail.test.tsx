import type { SignedEvent } from '@1nky/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One flick, full size.
 *
 * What is tested here is the thing a screenshot cannot show: the walls on this
 * page are not what the flick said, they are what the flick said PLUS what its
 * writer added afterwards — and an addition signed by anybody else counts for
 * nothing. Plus who gets the "Add to this" affordance at all: the writer who put
 * it up, nobody else.
 */

/** What `relay.query` hands back for the flick itself. */
let flickEvent: SignedEvent | null = null;
/** What the kind-1113 subscription hands back. */
let additions: SignedEvent[] = [];
/** Filters the page subscribed with, so the test can see what it asked for. */
let subscribed: Record<string, unknown>[] = [];
/** Every addition that went up from the panel. */
const putUp: { boards?: readonly string[]; mentions?: readonly string[] }[] = [];

vi.mock('../components/Identicon.js', () => ({ Identicon: () => null }));

vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => (flickEvent ? [flickEvent] : [])),
    subscribe: vi.fn(
      (
        filters: Record<string, unknown>[],
        handlers: { onEvent: (event: SignedEvent) => void },
      ) => {
        subscribed.push(...filters);
        const kinds = (filters[0]?.['kinds'] ?? []) as number[];
        if (kinds.includes(1113)) for (const event of additions) handlers.onEvent(event);
        return { close: vi.fn() };
      },
    ),
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
  } as unknown as (typeof import('../lib/relay.js'))['relay'],
}));

vi.mock('../lib/publish.js', () => ({
  postComment: vi.fn(async () => ({ id: 'e'.repeat(64) })),
  buffEvents: vi.fn(async () => ({ id: 'd'.repeat(64) })),
  amendPost: vi.fn(
    async (
      _tag: unknown,
      _target: unknown,
      input: { boards?: readonly string[]; mentions?: readonly string[] } = {},
    ) => {
      putUp.push(input);
      return { id: 'c'.repeat(64) };
    },
  ),
}));

const { FlickDetail } = await import('./FlickDetail.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { ToastProvider } = await import('../state/ToastProvider.js');
const { createTag } = await import('../lib/identity.js');
const { resetDbHandle } = await import('../lib/db.js');
const { resetIgnoredCache } = await import('../lib/mute.js');
const { buildAmendment, buildFlick, finalizeEvent, generateSecretKey, getPublicKey, KINDS } =
  await import('@1nky/protocol');

const SHA = 'ab'.repeat(32);

function flickFor(secret: Uint8Array, boards: readonly string[]): SignedEvent {
  return finalizeEvent(
    buildFlick({
      url: 'https://cdn.example/one.webp',
      sha256: SHA,
      dims: { width: 100, height: 200 },
      boards,
      caption: 'rooftop panel',
      createdAt: Math.floor(Date.now() / 1000) - 600,
    }),
    secret,
  );
}

function additionFor(secret: Uint8Array, boards: readonly string[]): SignedEvent {
  const target = flickEvent as SignedEvent;
  return finalizeEvent(
    buildAmendment(
      { id: target.id, pubkey: target.pubkey, kind: KINDS.FLICK },
      { boards, createdAt: Math.floor(Date.now() / 1000) - 60 },
    ),
    secret,
  );
}

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  resetIgnoredCache();
  flickEvent = null;
  additions = [];
  subscribed = [];
  putUp.length = 0;
  // The writer-summary lookup; nothing here depends on what it says.
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response) as never,
  );
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (root) {
    act(() => root!.unmount());
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
  const id = (flickEvent as SignedEvent).id;
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <TagProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/f/${id}`]}>
            <Routes>
              <Route path="/f/:id" element={<FlickDetail />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </TagProvider>,
    );
  });
  await settle();
}

function walls(): string[] {
  return [...container.querySelectorAll('a.chip')].map((a) => a.textContent ?? '');
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined;
}

describe('a flick page', () => {
  it('shows the walls it went up on, each a door to that wall', async () => {
    const tag = await createTag('SMOG');
    flickEvent = flickFor(tag.secret, ['sf', 'trains']);
    await mount();

    expect(container.textContent).toContain('rooftop panel');
    expect(walls()).toEqual(['#sf', '#trains']);
    expect(container.querySelector('a.chip')?.getAttribute('href')).toBe('/b/sf');
  });

  it('shows the walls the writer added afterwards, beside the original ones', async () => {
    const tag = await createTag('SMOG');
    flickEvent = flickFor(tag.secret, ['sf']);
    additions = [additionFor(tag.secret, ['Oakland'])];
    await mount();

    expect(walls()).toEqual(['#sf', '#oakland']);
    // It asked the wall for additions pointing at this flick, by id.
    expect(subscribed).toContainEqual(
      expect.objectContaining({ kinds: [KINDS.AMENDMENT], '#e': [(flickEvent as SignedEvent).id] }),
    );
  });

  it('ignores an addition signed by somebody else', async () => {
    const tag = await createTag('SMOG');
    flickEvent = flickFor(tag.secret, ['sf']);
    additions = [additionFor(generateSecretKey(), ['tagfarm'])];
    await mount();

    expect(walls()).toEqual(['#sf']);
    expect(container.textContent).not.toContain('tagfarm');
  });

  it('offers "Add to this" on your own flick only', async () => {
    const tag = await createTag('SMOG');
    flickEvent = flickFor(tag.secret, ['sf']);
    await mount();
    expect(button('Add to this')).toBeDefined();

    // Somebody else's: no addition affordance at all.
    await act(async () => root!.unmount());
    root = null;
    const stranger = generateSecretKey();
    getPublicKey(stranger);
    flickEvent = flickFor(stranger, ['sf']);
    await mount();
    expect(button('Add to this')).toBeUndefined();
  });

  it('shows an added wall straight away, without waiting for the wall to echo it', async () => {
    const tag = await createTag('SMOG');
    flickEvent = flickFor(tag.secret, ['sf']);
    await mount();

    await act(async () => {
      button('Add to this')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    const input = container.querySelector('#add-walls') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'Oakland',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();

    await act(async () => {
      button('Put it up')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    expect(putUp).toEqual([{ boards: ['oakland'], recordOwn: true, onStage: expect.any(Function) }]);
    expect(walls()).toEqual(['#sf', '#oakland']);
  });
});
