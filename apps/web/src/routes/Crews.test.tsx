import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Identicon paints a canvas; happy-dom has no 2D context. Render a stub so the
// tree mounts without hitting canvas APIs, while still revealing the pubkey the
// row is bound to.
vi.mock('../components/Identicon.js', () => ({
  Identicon: ({ pubkey, size }: { pubkey: string; size?: number }) =>
    // Keep DOM-shaped props only so this is a plain element.
    null,
}));

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

const { Crews } = await import('./Crews.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { createTag } = await import('../lib/identity.js');
const { saveFoundedCrew } = await import('../lib/crews.js');
const { resetDbHandle } = await import('../lib/db.js');

const crewPubkey = 'a'.repeat(64);

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ writer: { crews: [] } }));
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
        <MemoryRouter>
          <Crews />
        </MemoryRouter>
      </TagProvider>,
    );
  });
  // Flush the chains: TagProvider loads the tag, Crews loads founded crews +
  // fetches writer crews. Several awaited microtask rounds settle all effects.
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('Crews hub', () => {
  it('renders a founded crew as a link to its crew page', async () => {
    await createTag('FOUNDER');
    await saveFoundedCrew({ pubkey: crewPubkey, name: 'FASE', foundedByMe: true });

    await mount();

    const link = container.querySelector(`a[href="/crew/${crewPubkey}"]`);
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('FASE');
    // The founder gets a tag on the row.
    expect(link!.querySelector('.kicker')?.textContent).toContain('founder');
  });

  it('shows the graffiti-voice empty state with a Start button when there are no crews', async () => {
    await createTag('FOUNDER');
    await mount();

    const start = container.querySelector('a[href="/crew/new"]');
    expect(start).not.toBeNull();
    expect(container.textContent).toMatch(/no crews on your tag yet/i);
  });
});