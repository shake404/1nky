import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Taking a put-on — the receiving half, which only ever happens here.
 *
 * A newcomer's very first profile is the ONE event that can carry a put-on, so
 * this pins that the thing they were handed actually rides on it. It also pins
 * the shape of the rest of onboarding: somebody who turns up with nothing sees
 * and does exactly what they always did, and a bent string is refused out loud
 * rather than quietly dropped (dropping it would burn theirs for good).
 */

// The real miner grinds work in a worker; capture the template instead.
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

const { PickTag } = await import('./PickTag.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { ToastProvider } = await import('../state/ToastProvider.js');
const { loadTag } = await import('../lib/identity.js');
const { resetDbHandle } = await import('../lib/db.js');
const { KINDS, JARGON_BLOCKLIST } = await import('@1nky/protocol');

const INVITER = 'b'.repeat(64);
const INVITE_ID = '9'.repeat(32);
const CODE = `${INVITE_ID}.${INVITER}`;

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  mineAndSign.mockClear();
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

async function mount(entry = '/pick'): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <TagProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[entry]}>
            <PickTag />
          </MemoryRouter>
        </ToastProvider>
      </TagProvider>,
    );
  });
  await settle();
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pick(name: string): Promise<void> {
  await type(container.querySelector<HTMLInputElement>('#tag-name')!, name);
  const button = [...container.querySelectorAll('button')].find((b) => b.type === 'submit')!;
  await act(async () => {
    button.click();
  });
  await settle();
}

/** The kind-0 that went up, as the miner saw it. */
function profileTemplateSent(): { kind: number; tags: string[][]; content: string } | undefined {
  return mineAndSign.mock.calls.map((call) => call[0]).find((template) => template.kind === KINDS.PROFILE);
}

describe('turning up with a put-on', () => {
  it('carries what they were handed onto their first profile', async () => {
    await mount(`/pick?puton=${CODE}`);
    await pick('SHOCK');

    const template = profileTemplateSent();
    expect(template).toBeDefined();
    expect(template!.tags).toContainEqual(['invite', INVITE_ID, INVITER]);
    // The tag itself is set up either way — nothing about onboarding changed.
    expect((await loadTag())?.name).toBe('SHOCK');
  });

  it('takes one pasted in by hand just the same', async () => {
    await mount();

    // The field is out of the way until it is asked for.
    expect(container.querySelector('#put-on-code')).toBeNull();
    const reveal = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Got put on?'))!;
    await act(async () => {
      reveal.click();
    });

    await type(container.querySelector<HTMLInputElement>('#put-on-code')!, CODE);
    expect(container.textContent).toMatch(/somebody put you on/i);

    await pick('SHOCK');
    expect(profileTemplateSent()!.tags).toContainEqual(['invite', INVITE_ID, INVITER]);
  });

  it('reads one back out of the whole link they were sent', async () => {
    await mount(`/pick?puton=${encodeURIComponent(`https://1nky.com/pick?puton=${CODE}`)}`);
    await pick('SHOCK');

    expect(profileTemplateSent()!.tags).toContainEqual(['invite', INVITE_ID, INVITER]);
  });

  it('says they are on once it has gone through', async () => {
    await mount(`/pick?puton=${CODE}`);
    await pick('SHOCK');

    expect(container.querySelector('.toast')?.textContent).toBe("You're on.");
  });
});

describe('turning up with something bent, or with nothing', () => {
  it('refuses a bent one out loud instead of quietly burning it', async () => {
    await mount('/pick?puton=nonsense');

    expect(container.textContent).toContain("That's not a real put-on.");

    await pick('SHOCK');

    // Nothing went up and no tag was set up — they get to fix it and retry.
    expect(mineAndSign).not.toHaveBeenCalled();
    expect(await loadTag()).toBeNull();
    expect(container.querySelector('.error')?.textContent).toContain("That's not a real put-on.");
  });

  it('leaves onboarding exactly as it was for somebody who has nothing', async () => {
    await mount();
    await pick('SHOCK');

    const template = profileTemplateSent();
    expect(template).toBeDefined();
    expect(template!.tags.some((t) => t[0] === 'invite')).toBe(false);
    expect((await loadTag())?.name).toBe('SHOCK');
    expect(container.querySelector('.toast')).toBeNull();
  });

  it('still refuses an empty tag, put-on or not', async () => {
    await mount(`/pick?puton=${CODE}`);
    await pick('   ');

    expect(container.querySelector('.error')?.textContent).toBe('Pick something.');
    expect(mineAndSign).not.toHaveBeenCalled();
  });

  it('says nothing from the jargon blocklist, and never calls it a code', async () => {
    await mount(`/pick?puton=${CODE}`);
    const reveal = container.querySelector('#put-on-code');
    expect(reveal).not.toBeNull();

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
    expect(words).not.toContain('invite');
    expect(words).not.toContain('code');
  });
});
