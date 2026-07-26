import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announceUpdate, resetUpdateBusForTests } from '../lib/updateBus.js';

/**
 * The tap-to-refresh toast. Nothing renders until updateBus hears that a
 * build is waiting; once it does, tapping the toast must call the exact
 * function updateBus handed over — nothing else reloads the page on its
 * own behalf.
 */

const { UpdateToast } = await import('./UpdateToast.js');

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
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  setActEnv(false);
  resetUpdateBusForTests();
});

function mount(node: JSX.Element): void {
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

describe('UpdateToast', () => {
  it('renders nothing when no build is waiting', () => {
    mount(<UpdateToast />);
    expect(container.querySelector('.update-toast')).toBeNull();
  });

  it('shows the tap-to-update toast once a build is announced', () => {
    mount(<UpdateToast />);

    act(() => {
      announceUpdate(vi.fn());
    });

    const toast = container.querySelector('.update-toast');
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toContain('Fresh coat available');
    expect(toast!.textContent).not.toMatch(/service worker|cache|nostr/i);
  });

  it('shows the toast immediately if a build was already announced before mounting', () => {
    announceUpdate(vi.fn());
    mount(<UpdateToast />);

    expect(container.querySelector('.update-toast')).not.toBeNull();
  });

  it('calls the exact apply function updateBus handed over when tapped', () => {
    const apply = vi.fn();
    mount(<UpdateToast />);

    act(() => {
      announceUpdate(apply);
    });

    const button = container.querySelector('button.update-toast__btn') as HTMLButtonElement;
    expect(apply).not.toHaveBeenCalled();

    act(() => {
      button.click();
    });

    expect(apply).toHaveBeenCalledTimes(1);
  });
});
