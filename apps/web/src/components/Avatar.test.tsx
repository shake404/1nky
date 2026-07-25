import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one place picture-vs-mark is decided.
 *
 * When a writer has set a picture, it shows; the moment anything is wrong with
 * it — no address, a malformed one, or the picture failing to load — the
 * deterministic block-mark takes its place. A broken image must never sit where
 * a recognisable mark would.
 */

vi.mock('./Identicon.js', () => ({
  Identicon: ({ pubkey }: { pubkey: string }) => <span data-mark={pubkey} className="identicon" />,
}));

const { Avatar } = await import('./Avatar.js');
const { MEDIA_BASE } = await import('../lib/config.js');

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

const PUBKEY = 'a'.repeat(64);
const SHA = 'b'.repeat(64);

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
});

function mount(node: JSX.Element): void {
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

describe('the avatar', () => {
  it('shows their picture from the media address when they have set one', () => {
    mount(<Avatar pubkey={PUBKEY} avatarSha256={SHA} size={48} />);

    const img = container.querySelector('img.avatar');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(`${MEDIA_BASE}/${SHA}`);
    expect(container.querySelector('.identicon[data-mark]')).toBeNull();
  });

  it('falls back to the block-mark when there is no picture', () => {
    mount(<Avatar pubkey={PUBKEY} avatarSha256={null} size={48} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.identicon')?.getAttribute('data-mark')).toBe(PUBKEY);
  });

  it('falls back to the block-mark for a malformed address', () => {
    mount(<Avatar pubkey={PUBKEY} avatarSha256="not-a-real-hash" size={48} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.identicon')).not.toBeNull();
  });

  it('falls back to the block-mark when the picture fails to load', () => {
    mount(<Avatar pubkey={PUBKEY} avatarSha256={SHA} size={48} />);
    const img = container.querySelector('img.avatar')!;

    act(() => {
      img.dispatchEvent(new Event('error'));
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.identicon')?.getAttribute('data-mark')).toBe(PUBKEY);
  });
});
