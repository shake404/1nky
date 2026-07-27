import { useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RegionPicker } from './RegionPicker.js';

/**
 * The "Region" picker.
 *
 * The sibling of `WallPicker.test.tsx`: the load-bearing behaviour is the
 * same shape — a writer who types `the-bay` or `bay` ends up posting
 * `region-bay-area`, so one scene stops minting four feeds, but a scene no
 * dataset carries can still be named as typed. The one real difference from
 * the wall picker is that the region gazetteer is bundled rather than
 * fetched, so there is no "wakes on focus" fetch behaviour to test here —
 * and the field is optional, so an empty box is a normal resting state, not
 * an error.
 */

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;
let value = '';

function Harness(): JSX.Element {
  const [region, setRegion] = useState('');
  value = region;
  return <RegionPicker id="region" value={region} onChange={setRegion} />;
}

beforeEach(() => {
  setActEnv(true);
  value = '';
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
  return container.querySelector('#region') as HTMLInputElement;
}

async function focus(): Promise<void> {
  await act(async () => {
    // React 18 delegates onFocus from `focusin`, not the non-bubbling `focus`.
    input().dispatchEvent(new Event('focusin', { bubbles: true }));
  });
  await settle();
}

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

describe('RegionPicker — resting state', () => {
  it('is empty and offers nothing until something is typed', async () => {
    await mount();
    await focus();
    expect(input().value).toBe('');
    expect(options()).toHaveLength(0);
  });

  it('says the field is optional rather than demanding a scene', async () => {
    await mount();
    expect(container.textContent?.toLowerCase()).toContain('optional');
  });
});

describe('RegionPicker — suggestions', () => {
  it('offers scenes as the writer types', async () => {
    await mount();
    await type('bay ar');
    expect(optionText().join(' ')).toContain('Bay Area');
  });

  it('offers a scene by its nickname, so "the-bay" finds Bay Area', async () => {
    await mount();
    await type('the-bay');
    expect(optionText()[0]).toContain('Bay Area');
  });

  it('says nothing about coordinates, datasets or maps', async () => {
    await mount();
    await type('bay area');
    const text = container.textContent ?? '';
    for (const word of ['coordinate', 'latitude', 'geonames', 'api', 'licen']) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

describe('RegionPicker — picking a scene emits the canonical slug', () => {
  it('emits the canonical slug when a suggestion is taken', async () => {
    await mount();
    await type('the-bay');
    await clickOption(0);
    expect(value).toBe('bay-area');
  });

  it('takes the first suggestion on Enter with nothing highlighted', async () => {
    await mount();
    await type('pacific-northwest');
    await press('Enter');
    expect(value).toBe('pnw');
  });

  it('closes the list once a scene is taken', async () => {
    await mount();
    await type('the-bay');
    await clickOption(0);
    expect(options()).toHaveLength(0);
  });

  it('confirms the scene in words after it is picked', async () => {
    await mount();
    await type('the-bay');
    await clickOption(0);
    expect(container.textContent).toContain('Bay Area');
  });

  it('lets Escape dismiss the list without changing the field', async () => {
    await mount();
    await type('socal');
    await press('Escape');
    expect(options()).toHaveLength(0);
    expect(value).toBe('socal');
  });
});

describe('RegionPicker — typing wins too (no hard restriction)', () => {
  it('keeps whatever the writer types when the gazetteer has never heard of it', async () => {
    await mount();
    await type('walla-walla-scene');
    expect(value).toBe('walla-walla-scene');
  });

  it('slugifies as it goes', async () => {
    await mount();
    await type('Walla Walla Scene');
    expect(value).toBe('walla-walla-scene');
  });

  it('warns nobody off a scene the list does not carry', async () => {
    await mount();
    await type('walla-walla-scene');
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).not.toContain('invalid');
    expect(text).not.toContain('error');
    expect(text).not.toContain('not allowed');
  });

  it('tells the writer in words when what they typed will fold into a known scene', async () => {
    await mount();
    await type('the-bay');
    expect(container.textContent).toContain('Bay Area');
  });

  it('leaves the field empty when the writer clears it', async () => {
    await mount();
    await type('socal');
    await type('');
    expect(value).toBe('');
    expect(options()).toHaveLength(0);
  });
});

describe('RegionPicker — accessibility', () => {
  it('announces itself as a combobox with a list', async () => {
    await mount();
    await type('bay');
    const node = input();
    expect(node.getAttribute('role')).toBe('combobox');
    expect(node.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it('reports the list closed when there is nothing to offer', async () => {
    await mount();
    await type('zzzzzzzzzz');
    expect(input().getAttribute('aria-expanded')).toBe('false');
  });

  it('marks the highlighted option as selected', async () => {
    await mount();
    await type('a');
    const before = options().map((n) => n.getAttribute('aria-selected'));
    expect(before.every((v) => v === 'false')).toBe(true);
    await press('ArrowDown');
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
  });
});
