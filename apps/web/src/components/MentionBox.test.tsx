import { useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MentionBox } from './MentionBox.js';
import type { MentionCandidate } from '../lib/mentions.js';

/**
 * The reply box with the typeahead on it.
 *
 * The load-bearing behaviour: typing `@` surfaces the writers already in the
 * thread, taking one drops the real `@tag` into the draft, and — crucially —
 * Enter takes the highlighted writer instead of sending or breaking the line,
 * so the mention never collides with "put it up".
 */

const SHAKE: MentionCandidate = { pubkey: 'a'.repeat(64), tag: 'SHAKE', mark: 'aa11bb' };
const RASK: MentionCandidate = { pubkey: 'c'.repeat(64), tag: 'RASK', mark: 'cc33dd' };

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

/** Last value the harness saw — the "draft" the composer would send. */
let value = '';

function Harness(): JSX.Element {
  const [text, setText] = useState('');
  value = text;
  return (
    <MentionBox
      id="reply"
      value={text}
      onChange={setText}
      candidates={[SHAKE, RASK]}
      maxLength={2000}
    />
  );
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
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness />);
  });
  await settle();
}

function box(): HTMLTextAreaElement {
  return container.querySelector('#reply') as HTMLTextAreaElement;
}

/** Type `text`, leaving the caret at its end, the way a person would. */
async function typeInto(node: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(node, text);
    node.setSelectionRange(text.length, text.length);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function key(node: HTMLTextAreaElement, k: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  await act(async () => {
    node.dispatchEvent(event);
  });
  await settle();
  return event;
}

describe('MentionBox', () => {
  it('surfaces a matching writer once you type @ and a couple letters', async () => {
    await mount();
    await typeInto(box(), '@sh');

    const menu = container.querySelector('.mention-menu');
    expect(menu).not.toBeNull();
    const items = [...menu!.querySelectorAll('.mention-menu__item')];
    // Only SHAKE matches "sh"; RASK does not.
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('@SHAKE');
  });

  it('takes the highlighted writer on Enter, and does not add a newline or submit', async () => {
    await mount();
    await typeInto(box(), '@sh');

    const event = await key(box(), 'Enter');
    // Enter was intercepted by the typeahead, not passed to the textarea/form.
    expect(event.defaultPrevented).toBe(true);
    expect(value).toBe('@SHAKE ');
    expect(value).not.toContain('\n');
    // Picking closes the list.
    expect(container.querySelector('.mention-menu')).toBeNull();
  });

  it('closes the list on Escape without touching the draft', async () => {
    await mount();
    await typeInto(box(), '@sh');
    expect(container.querySelector('.mention-menu')).not.toBeNull();

    await key(box(), 'Escape');
    expect(container.querySelector('.mention-menu')).toBeNull();
    expect(value).toBe('@sh');
  });
});
