import { useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WallPicker } from './WallPicker.js';
import { resetWallsCache } from '../lib/walls.js';

/**
 * The "Where" picker.
 *
 * The load-bearing behaviour: a writer who types `sf` or `frisco` ends up
 * posting to `san-francisco`, so one city stops minting four walls — but a
 * writer in a town no dataset carries can still name their own wall. Both at
 * once is the whole design; a hard-restricted list would have orphaned the
 * second writer.
 *
 * It also must never reach off-origin. The only fetch it is allowed to make is
 * for our own /cities.json.
 */

const PAYLOAD = {
  version: 1,
  regions: ['California', 'England', 'Ontario', 'West Bank'],
  countries: { US: 'United States', GB: 'United Kingdom', CA: 'Canada', PS: 'Palestine' },
  cities: [
    ['san-francisco', 'San Francisco', 0, 'US', 676],
    ['oakland', 'Oakland', 0, 'US', 850],
    ['london', 'London', 1, 'GB', 10],
    ['london-ca', 'London', 2, 'CA', 900],
    ['ramallah', 'Ramallah', 3, 'PS', 2452],
  ],
};

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;
let value = '';

const spyOnFetch = () => vi.spyOn(globalThis, 'fetch');
let fetchSpy: ReturnType<typeof spyOnFetch>;

function Harness(): JSX.Element {
  const [wall, setWall] = useState('');
  value = wall;
  return <WallPicker id="where" value={wall} onChange={setWall} />;
}

beforeEach(() => {
  setActEnv(true);
  resetWallsCache();
  value = '';
  fetchSpy = spyOnFetch();
  fetchSpy.mockImplementation(
    async () => ({ ok: true, json: async () => PAYLOAD }) as unknown as Response,
  );
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
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness />);
  });
  await settle();
}

function input(): HTMLInputElement {
  return container.querySelector('#where') as HTMLInputElement;
}

async function focus(): Promise<void> {
  await act(async () => {
    // React 18 delegates onFocus from `focusin`, not the non-bubbling `focus`.
    input().dispatchEvent(new Event('focusin', { bubbles: true }));
  });
  await settle();
}

/**
 * Type `text` the way a person would: focus first, then let React see the
 * change. React tracks a controlled input's value, so the assignment has to go
 * through the native setter or the synthetic onChange never fires.
 */
async function type(text: string): Promise<void> {
  await focus();
  const node = input();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(node, text);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

function options(): HTMLElement[] {
  return [...container.querySelectorAll('[role="option"]')] as HTMLElement[];
}

function optionText(): string[] {
  return options().map((node) => node.textContent ?? '');
}

async function press(key: string): Promise<void> {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  await settle();
}

async function clickOption(index: number): Promise<void> {
  await act(async () => {
    options()[index]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
  await settle();
}

describe('WallPicker — where the dataset comes from', () => {
  it('fetches only from our own origin', async () => {
    await mount();
    await focus();
    for (const call of fetchSpy.mock.calls) {
      const url = String(call[0]);
      expect(url.startsWith('/')).toBe(true);
      expect(url).not.toMatch(/^https?:/);
    }
  });

  it('does not download the city list until somebody opens the picker', async () => {
    await mount();
    expect(fetchSpy).not.toHaveBeenCalled();
    await focus();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('WallPicker — suggestions', () => {
  it('suggests nothing before anything is typed', async () => {
    await mount();
    await focus();
    expect(options()).toHaveLength(0);
  });

  it('offers cities as the writer types', async () => {
    await mount();
    await type('san fran');
    expect(optionText().join(' ')).toContain('San Francisco');
  });

  it('offers a city by its nickname, so "frisco" finds San Francisco', async () => {
    await mount();
    await type('frisco');
    expect(optionText()[0]).toContain('San Francisco');
  });

  it('shows the region so two cities with one name are told apart', async () => {
    await mount();
    await type('london');
    const text = optionText();
    expect(text[0]).toContain('England');
    expect(text[1]).toContain('Ontario');
  });

  it('says nothing about coordinates, datasets or maps', async () => {
    await mount();
    await type('london');
    const text = container.textContent ?? '';
    for (const word of ['GeoNames', 'coordinate', 'latitude', 'map', 'API', 'licen']) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

describe('WallPicker — picking a wall emits the canonical slug', () => {
  it('emits the canonical slug when a suggestion is taken', async () => {
    await mount();
    await type('frisco');
    await clickOption(0);
    expect(value).toBe('san-francisco');
  });

  it('walks the list with the arrow keys and takes one with Enter', async () => {
    await mount();
    await type('london');
    // Nothing is highlighted until the first ArrowDown, so reaching the second
    // city takes two — the ordinary combobox bargain, and the reason Enter on
    // an untouched list takes the best match rather than a random one.
    await press('ArrowDown');
    await press('ArrowDown');
    await press('Enter');
    expect(value).toBe('london-ca');
  });

  it('takes the first suggestion on Enter with nothing highlighted', async () => {
    await mount();
    await type('london');
    await press('Enter');
    expect(value).toBe('london');
  });

  it('closes the list once a wall is taken', async () => {
    await mount();
    await type('frisco');
    await clickOption(0);
    expect(options()).toHaveLength(0);
  });

  it('confirms the wall in words after it is picked', async () => {
    await mount();
    await type('frisco');
    await clickOption(0);
    expect(container.textContent).toContain('San Francisco, California');
  });

  it('lets Escape dismiss the list without changing the wall', async () => {
    await mount();
    await type('london');
    await press('Escape');
    expect(options()).toHaveLength(0);
    expect(value).toBe('london');
  });
});

describe('WallPicker — typing wins too (no hard restriction)', () => {
  it('keeps whatever the writer types', async () => {
    await mount();
    await type('walla-walla');
    expect(value).toBe('walla-walla');
  });

  it('slugifies as it goes, so a typed city is already a wall slug', async () => {
    await mount();
    await type('Walla Walla');
    expect(value).toBe('walla-walla');
  });

  it('warns nobody off a wall the list does not carry', async () => {
    await mount();
    await type('walla-walla');
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).not.toContain('invalid');
    expect(text).not.toContain('error');
    expect(text).not.toContain('not allowed');
  });

  it('tells the writer when what they typed will fold into a known wall', async () => {
    await mount();
    await type('sf');
    expect(container.textContent).toContain('San Francisco, California');
  });

  it('still folds a typed alias even when the city list never loaded', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await mount();
    await type('sf');
    // No suggestions to offer, but the bundled alias map still canonicalizes.
    await press('Enter');
    expect(value).toBe('san-francisco');
  });

  it('leaves the field empty when the writer clears it', async () => {
    await mount();
    await type('london');
    await type('');
    expect(value).toBe('');
    expect(options()).toHaveLength(0);
  });

  it('does not erase a half-typed city that is not yet a slug', async () => {
    await mount();
    // A leading apostrophe canonicalizes to nothing, which zeroes the emitted
    // wall — but somebody typing 's-Hertogenbosch is one character in and their
    // text must stay put rather than vanish under them.
    await type("'");
    expect(input().value).toBe("'");
    expect(value).toBe('');
    await type("'s-hertogenbosch");
    expect(value).toBe('s-hertogenbosch');
  });
});

describe('WallPicker — accessibility', () => {
  it('announces itself as a combobox with a list', async () => {
    await mount();
    await type('london');
    const node = input();
    expect(node.getAttribute('role')).toBe('combobox');
    expect(node.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it('reports the list closed when there is nothing to offer', async () => {
    await mount();
    await type('zzzzzz');
    expect(input().getAttribute('aria-expanded')).toBe('false');
  });

  it('marks the highlighted option as selected', async () => {
    await mount();
    await type('london');
    expect(options().map((n) => n.getAttribute('aria-selected'))).toEqual(['false', 'false']);
    await press('ArrowDown');
    expect(options().map((n) => n.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  });
});
