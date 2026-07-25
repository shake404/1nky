import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "Blur faces" switch.
 *
 * The arithmetic of covering a face is tested in `lib/blur.test.ts`; what
 * matters here is the contract with the post screen, and especially the awkward
 * half of it: a writer who asked for faces to be covered must never end up
 * posting uncovered faces because the tool would not load. So the failure path
 * gets as much attention as the happy one.
 *
 * The detector, the canvas drawing and the encode are stood in for — none of
 * them exist in this DOM, and none of them are what this test is about.
 */

const detect = vi.fn(() => ({
  detections: [{ boundingBox: { originX: 60, originY: 60, width: 40, height: 40 } }],
}));
let loadFails = false;
const loadFaceFinder = vi.fn(async () => {
  if (loadFails) throw new Error('no runtime here');
  return { detect };
});
const drawInto = vi.fn(async () => ({ width: 400, height: 300 }));
const canvasToBlob = vi.fn(async () => new Blob(['covered'], { type: 'image/webp' }));
const coverBoxes = vi.fn((_surface: unknown, boxes: readonly unknown[]) => [...boxes]);

vi.mock('../lib/blur.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/blur.js')>();
  return { ...real, loadFaceFinder, drawInto, canvasToBlob, coverBoxes };
});

const { BlurFaces } = await import('./BlurFaces.js');
const { BLUR_LOAD_FAILED } = await import('../lib/blur.js');
const { JARGON_BLOCKLIST } = await import('@1nky/protocol');

function setActEnv(value: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = value;
}

const picture = (): File => new File(['bytes'], 'wall.jpg', { type: 'image/jpeg' });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;
let blurred: (Blob | null)[] = [];
let blocked: boolean[] = [];
let realGetContext: typeof HTMLCanvasElement.prototype.getContext;

beforeEach(() => {
  setActEnv(true);
  loadFails = false;
  blurred = [];
  blocked = [];
  detect.mockClear();
  loadFaceFinder.mockClear();
  drawInto.mockClear();
  canvasToBlob.mockClear();
  coverBoxes.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  // This DOM has no 2D context at all; the component only needs something
  // truthy to hand to the (stood-in) covering.
  realGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() => ({ stub: true })) as never;
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
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

async function mount(file: File | null): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <BlurFaces
        file={file}
        onBlurred={(blob) => blurred.push(blob)}
        onBlocked={(value) => blocked.push(value)}
      />,
    );
  });
  await settle();
}

function box(): HTMLInputElement {
  const found = container.querySelector('input[type="checkbox"]');
  if (!found) throw new Error('no switch');
  return found as HTMLInputElement;
}

async function flip(on: boolean): Promise<void> {
  const node = box();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!.call(node, on);
    node.dispatchEvent(new Event('click', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

describe('the blur switch', () => {
  it('is not there at all until there is a picture', async () => {
    await mount(null);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('is off to start with, and loads nothing', async () => {
    await mount(picture());

    expect(box().checked).toBe(false);
    expect(loadFaceFinder).not.toHaveBeenCalled();
    expect(drawInto).not.toHaveBeenCalled();
    // Nothing to upload but the picked file itself.
    expect(blurred.every((blob) => blob === null)).toBe(true);
    expect(blocked.every((value) => value === false)).toBe(true);
  });

  it('loads the tool only when it is first switched on', async () => {
    await mount(picture());
    await flip(true);

    expect(loadFaceFinder).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(coverBoxes).toHaveBeenCalled();
    // What goes up is the covered canvas, not the picked file.
    expect(blurred.at(-1)).toBeInstanceOf(Blob);
    expect(container.textContent).toContain('1 covered');
    expect(container.textContent).toContain('This is exactly what goes up.');
  });

  it('switching it back off goes back to the picked file, unblocked', async () => {
    await mount(picture());
    await flip(true);
    expect(blurred.at(-1)).toBeInstanceOf(Blob);

    await flip(false);

    expect(blurred.at(-1)).toBeNull();
    expect(blocked.at(-1)).toBe(false);
    expect(container.textContent).toContain('Off unless you ask for it.');
  });

  it('covers what the writer taps as well as what was found', async () => {
    await mount(picture());
    await flip(true);

    const canvas = container.querySelector('canvas')!;
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 300 }) as DOMRect;
    await act(async () => {
      canvas.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 150 }),
      );
    });
    await settle();

    expect(container.textContent).toContain('2 covered');
    // The last covering pass was handed both the found box and the tapped one.
    expect((coverBoxes.mock.calls.at(-1)?.[1] as unknown[]).length).toBe(2);

    // And it can be taken back.
    const undo = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Undo last',
    );
    expect(undo).toBeDefined();
    await act(async () => {
      (undo as HTMLButtonElement).click();
    });
    await settle();
    expect(container.textContent).toContain('1 covered');
  });

  it('says when nothing was found, so a blank pass does not read as done', async () => {
    detect.mockReturnValueOnce({ detections: [] } as never);
    await mount(picture());
    await flip(true);

    expect(container.textContent).toContain('no faces found');
    // Still hands over the re-encoded canvas: it is the approved picture.
    expect(blurred.at(-1)).toBeInstanceOf(Blob);
  });

  it('blocks the post when the tool will not load, and says so plainly', async () => {
    loadFails = true;
    await mount(picture());
    await flip(true);

    expect(container.textContent).toContain(BLUR_LOAD_FAILED);
    expect(blocked.at(-1)).toBe(true);
    expect(blurred.at(-1)).toBeNull();
  });

  it('unblocks only when the writer switches it off themselves', async () => {
    loadFails = true;
    await mount(picture());
    await flip(true);
    expect(blocked.at(-1)).toBe(true);

    await flip(false);

    expect(blocked.at(-1)).toBe(false);
    expect(container.textContent).not.toContain(BLUR_LOAD_FAILED);
  });

  it('tries again on the next flip rather than staying broken', async () => {
    loadFails = true;
    await mount(picture());
    await flip(true);
    await flip(false);

    loadFails = false;
    await flip(true);

    expect(loadFaceFinder).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain(BLUR_LOAD_FAILED);
    expect(blurred.at(-1)).toBeInstanceOf(Blob);
  });

  it('says nothing from the jargon blocklist', async () => {
    await mount(picture());
    await flip(true);

    const words = (container.textContent ?? '').toLowerCase();
    for (const banned of JARGON_BLOCKLIST) {
      expect(words).not.toContain(banned);
    }
  });
});
