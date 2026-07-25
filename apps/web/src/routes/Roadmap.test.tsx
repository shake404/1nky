import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The roadmap.
 *
 * Two properties matter and both are easy to lose in a refactor: it reads with
 * nothing reachable (no wall read, so a dead connection cannot blank the page),
 * and it ends by pointing at the place a writer can change it.
 */

const { Roadmap } = await import('./Roadmap.js');
const { JARGON_BLOCKLIST } = await import('@1nky/protocol');

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  setActEnv(true);
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
      <MemoryRouter initialEntries={['/roadmap']}>
        <Roadmap />
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('the roadmap', () => {
  it('sorts the work into what is up, what is being worked on, and what is coming', async () => {
    await mount();

    expect(container.querySelector('h2')?.textContent).toBe("What's coming");
    for (const lane of ['up already', 'getting sprayed', 'next up', 'maybe, maybe not']) {
      expect(container.textContent?.toLowerCase()).toContain(lane);
    }
    // Every lane carries items, and the page is a real list rather than a stub.
    expect(container.querySelectorAll('.road').length).toBe(4);
    expect(container.querySelectorAll('.road > li').length).toBeGreaterThan(20);
  });

  it('names the things a writer would recognise from the docs', async () => {
    await mount();

    const words = container.textContent ?? '';
    expect(words).toContain('blackbook');
    expect(words).toContain('Beef');
    expect(words).toContain('Crews');
    expect(words).toContain('face and hand blur');
    expect(words).toContain('onion network');
    expect(words).toContain('jams and meets');
  });

  it('reads with nothing reachable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await mount();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ends by pointing at the place you can change it', async () => {
    await mount();

    expect(container.textContent).toContain('Want something? Holler.');
    expect(container.querySelector('a[href="/holler"]')).not.toBeNull();
  });

  it('says nothing from the jargon blocklist', async () => {
    await mount();

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
