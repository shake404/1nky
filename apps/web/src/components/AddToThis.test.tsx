import { KINDS } from '@1nky/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Add to this" — the panel that puts more walls and more writers on a post
 * that is already up.
 *
 * What is worth testing here is not the markup, it is the promises the panel
 * makes: it never rewrites what went up (it publishes a separate 1113 that
 * points at it), it signs with the key that PUT IT UP rather than whoever is on
 * screen, it refuses to send nothing, and it says none of the words the copy deck
 * forbids.
 */

const published: { kind: number; tags: string[][]; secret: string }[] = [];

vi.mock('../lib/publish.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/publish.js')>('../lib/publish.js');
  return {
    ...actual,
    amendPost: vi.fn(
      async (
        tag: { secret: Uint8Array },
        target: { id: string; pubkey: string; kind: number },
        input: { boards?: readonly string[]; mentions?: readonly string[] } = {},
      ) => {
        const { buildAmendment } = await import('@1nky/protocol');
        const template = buildAmendment(target, {
          ...(input.boards?.length ? { boards: input.boards } : {}),
          ...(input.mentions?.length ? { mentions: input.mentions } : {}),
        });
        published.push({
          kind: template.kind,
          tags: template.tags as string[][],
          secret: [...tag.secret].join(','),
        });
        return { id: 'f'.repeat(64) } as never;
      },
    ),
  };
});

const { AddToThis } = await import('./AddToThis.js');
const { JARGON_BLOCKLIST } = await import('@1nky/protocol');
const { amendPost } = await import('../lib/publish.js');

const OWNER = 'a'.repeat(64);
const NAMED = 'c'.repeat(64);
const FLICK = { id: 'b'.repeat(64), pubkey: OWNER, kind: KINDS.FLICK };

/** The crew key that put a crew's flick up — not the device's own tag. */
const CREW_SECRET = new Uint8Array(32).fill(7);
const crewTag = {
  pubkey: OWNER,
  secret: CREW_SECRET,
  name: 'FASE',
  hasPosted: true,
} as unknown as Parameters<typeof AddToThis>[0]['owner'];

const candidates = [
  { pubkey: NAMED, tag: 'KILO', mark: 'cc11dd' },
  { pubkey: OWNER, tag: 'SMOG', mark: 'aa22bb' },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;
let added: { boards: string[]; mentions: string[] }[] = [];
let errors: string[] = [];

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

beforeEach(() => {
  setActEnv(true);
  published.length = 0;
  added = [];
  errors = [];
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  setActEnv(false);
  vi.clearAllMocks();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(boards: readonly string[] = ['sf'], asCrew = false): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <AddToThis
        target={FLICK}
        owner={crewTag}
        asCrew={asCrew}
        boards={boards}
        candidates={candidates}
        onStage={() => {}}
        onAdded={(a) => added.push(a)}
        onError={(m) => errors.push(m)}
      />,
    );
  });
  await settle();
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').toLowerCase().includes(label.toLowerCase()),
  ) as HTMLButtonElement | undefined;
}

async function click(node: HTMLElement | undefined): Promise<void> {
  await act(async () => {
    node?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function type(selector: string, text: string): Promise<void> {
  const node = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!;
    setter.call(node, text);
    node.setSelectionRange?.(text.length, text.length);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

describe('AddToThis', () => {
  it('starts as one quiet button and opens a panel', async () => {
    await mount();
    expect(container.textContent).toContain('Add to this');
    expect(container.querySelector('#add-walls')).toBeNull();

    await click(button('Add to this'));
    expect(container.querySelector('#add-walls')).not.toBeNull();
    expect(container.querySelector('#add-writers')).not.toBeNull();
  });

  it('will not send nothing', async () => {
    await mount();
    await click(button('Add to this'));
    expect(button('Put it up')?.disabled).toBe(true);

    // A wall it is already on is nothing to add.
    await type('#add-walls', 'SF');
    expect(button('Put it up')?.disabled).toBe(true);

    await click(button('Put it up'));
    expect(published).toEqual([]);
  });

  it('puts up a separate addition rather than rewriting the post', async () => {
    await mount();
    await click(button('Add to this'));
    await type('#add-walls', 'Oakland, west oakland');
    await click(button('Put it up'));

    expect(published).toHaveLength(1);
    const event = published[0]!;
    // Its own kind, pointing at the original — the original is never re-sent.
    expect(event.kind).toBe(KINDS.AMENDMENT);
    expect(event.kind).not.toBe(KINDS.FLICK);
    expect(event.tags).toContainEqual(['e', FLICK.id, '', OWNER]);
    expect(event.tags).toContainEqual(['t', 'oakland']);
    expect(event.tags).toContainEqual(['t', 'west-oakland']);
    // And it reports what went up so the screen can show it at once.
    expect(added).toEqual([{ boards: ['oakland', 'west-oakland'], mentions: [] }]);
  });

  it('signs with the key that put it up, not with whoever is on screen', async () => {
    // A crew's flick: the addition has to carry the crew's key, exactly as
    // taking it down does.
    await mount(['sf'], true);
    await click(button('Add to this'));
    await type('#add-walls', 'oakland');
    await click(button('Put it up'));

    expect(published[0]?.secret).toBe([...CREW_SECRET].join(','));
    // And a crew's post is not this device's own work.
    expect(vi.mocked(amendPost).mock.calls[0]?.[2]).toMatchObject({ recordOwn: false });
  });

  it('names a writer picked in the @ box, and never the author themselves', async () => {
    await mount();
    await click(button('Add to this'));
    await type('#add-writers', 'with @KILO and @SMOG');
    await click(button('Put it up'));

    const tags = published[0]?.tags ?? [];
    expect(tags).toContainEqual(['p', NAMED, '', 'mention']);
    // SMOG is the author: naming yourself on your own post reaches nobody.
    expect(tags.filter((t) => t[0] === 'p')).toHaveLength(1);
    expect(added[0]?.mentions).toEqual([NAMED]);
  });

  it('hands an error back instead of swallowing it', async () => {
    vi.mocked(amendPost).mockRejectedValueOnce(new Error('That did not go up.'));
    await mount();
    await click(button('Add to this'));
    await type('#add-walls', 'oakland');
    await click(button('Put it up'));

    expect(errors).toEqual(['That did not go up.']);
    // The panel stays open with the draft intact, so nothing is retyped.
    expect((container.querySelector('#add-walls') as HTMLInputElement).value).toBe('oakland');
  });

  it('closes and clears when it is left alone', async () => {
    await mount();
    await click(button('Add to this'));
    await type('#add-walls', 'oakland');
    await click(button('Leave it'));

    expect(container.querySelector('#add-walls')).toBeNull();
    await click(button('Add to this'));
    expect((container.querySelector('#add-walls') as HTMLInputElement).value).toBe('');
  });

  it('says none of the forbidden words', async () => {
    await mount();
    await click(button('Add to this'));
    const text = (container.textContent ?? '').toLowerCase();
    for (const word of JARGON_BLOCKLIST) expect(text).not.toContain(word);
    // And never calls it an edit — nothing that went up is being changed.
    expect(text).not.toContain('edit');
    expect(text).not.toContain('amend');
    expect(text).not.toContain('delete');
  });
});
