import { IDBFactory } from 'fake-indexeddb';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Editing your tag — now with a picture.
 *
 * The picture rides the flick pipeline exactly: a picked file is stripped and
 * re-encoded by `prepareImage`, uploaded by `uploadBlob` (signed with this
 * tag's own secret), and the address the server hands back goes onto the kind-0
 * as `avatarSha256`. Taking the picture off re-publishes the tag with the field
 * cleared. The bio keeps working the whole time.
 */

const UPLOADED = 'c'.repeat(64);
const EXISTING = 'd'.repeat(64);

const CROPPED = new Blob(['cropped-square'], { type: 'image/webp' });
const uploadBlob = vi.fn(async (_blob: Blob, _secret: Uint8Array) => ({ sha256: UPLOADED, url: `http://media/${UPLOADED}` }));
vi.mock('../lib/flicks.js', () => ({ uploadBlob }));

// The cropper's canvas/Image work does not run under happy-dom; stand it in
// with a button that hands back a framed square, so the pick -> frame -> save
// path is exercised. The cropper's own geometry is unit-tested separately.
vi.mock('../components/AvatarCropper.js', () => ({
  AvatarCropper: (props: { onDone: (b: Blob) => void; onCancel: () => void }) =>
    createElement(
      'button',
      { type: 'button', onClick: () => props.onDone(CROPPED) },
      'Use this',
    ),
}));

const publishProfile = vi.fn(async (_tag: unknown, _opts: Record<string, unknown>) => ({ id: 'e'.repeat(64) }));
vi.mock('../lib/publish.js', () => ({
  publishProfile,
  publishTemplate: vi.fn(async () => ({ id: 'e'.repeat(64) })),
  PublishError: class PublishError extends Error {},
}));

let profileMeta: { name: string; bio?: string; avatarSha256?: string } | null = null;
const fetchProfile = vi.fn(async () => profileMeta);
vi.mock('../lib/profiles.js', () => ({
  fetchProfile,
  profileTemplate: vi.fn(),
  profileFromEvent: vi.fn(),
}));

vi.mock('../lib/crews.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/crews.js')>();
  return { ...real, fetchWriterCrews: vi.fn(async () => [] as string[]) };
});

vi.mock('../components/Identicon.js', () => ({ Identicon: () => null }));

vi.mock('../lib/relay.js', () => ({
  relay: {
    connect: vi.fn(),
    watch: vi.fn(() => () => {}),
    query: vi.fn(async () => []),
    publish: vi.fn(async () => ({ accepted: true, message: '' })),
  } as unknown as (typeof import('../lib/relay.js'))['relay'],
}));

const { ProfileEdit } = await import('./ProfileEdit.js');
const { TagProvider } = await import('../state/TagProvider.js');
const { ToastProvider } = await import('../state/ToastProvider.js');
const { createTag } = await import('../lib/identity.js');
const { resetDbHandle } = await import('../lib/db.js');
const { JARGON_BLOCKLIST } = await import('@1nky/protocol');

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  setActEnv(true);
  resetDbHandle();
  profileMeta = null;
  uploadBlob.mockClear();
  publishProfile.mockClear();
  fetchProfile.mockClear();
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview') as unknown as typeof URL.createObjectURL;
  globalThis.URL.revokeObjectURL = vi.fn();
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

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <TagProvider>
        <ToastProvider>
          <MemoryRouter>
            <ProfileEdit />
          </MemoryRouter>
        </ToastProvider>
      </TagProvider>,
    );
  });
  await settle();
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

async function press(label: string): Promise<void> {
  const target = button(label);
  await act(async () => {
    target.click();
  });
  await settle();
}

async function pick(): Promise<void> {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['bytes'], 'me.png', { type: 'image/png' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

/** The options object the ProfileEdit save handed to publishProfile. */
function lastPublish(): Record<string, unknown> {
  const calls = publishProfile.mock.calls;
  return calls[calls.length - 1]![1];
}

describe('editing your tag with a picture', () => {
  it('frames, uploads, and puts the returned address on the tag', async () => {
    await createTag('SHOCK');
    await mount();
    publishProfile.mockClear();

    await pick();
    // Picking opens the cropper; framing it hands back the square.
    await press('Use this');

    await press('Put it up');

    // Uploaded the framed square, signed with this tag's own secret.
    expect(uploadBlob).toHaveBeenCalledTimes(1);
    expect(uploadBlob.mock.calls[0]![0]).toBe(CROPPED);

    // The address the server returned is what went onto the kind-0.
    expect(publishProfile).toHaveBeenCalledTimes(1);
    expect(lastPublish()['avatarSha256']).toBe(UPLOADED);
  });

  it('clears the picture when it is taken off', async () => {
    profileMeta = { name: 'SHOCK', bio: 'up all night', avatarSha256: EXISTING };
    await createTag('SHOCK');
    await mount();
    publishProfile.mockClear();

    await press('Take it off');
    await press('Put it up');

    // Nothing new uploaded, and the tag goes up with the picture cleared.
    expect(uploadBlob).not.toHaveBeenCalled();
    expect(publishProfile).toHaveBeenCalledTimes(1);
    expect(lastPublish()['avatarSha256']).toBe('');
  });

  it('keeps the bio publishing whether or not a picture is set', async () => {
    profileMeta = { name: 'SHOCK', bio: 'keeps this bio' };
    await createTag('SHOCK');
    await mount();
    publishProfile.mockClear();

    await press('Put it up');

    expect(uploadBlob).not.toHaveBeenCalled();
    expect(publishProfile).toHaveBeenCalledTimes(1);
    expect(lastPublish()['bio']).toBe('keeps this bio');
    // No picture set and none picked: the field goes up empty.
    expect(lastPublish()['avatarSha256']).toBe('');
  });

  it('says nothing from the jargon blocklist', async () => {
    await createTag('SHOCK');
    await mount();

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
