/**
 * Blurring faces out of a flick, entirely on the device.
 *
 * The whole point is that nothing about this leaves the phone: the detector, the
 * model weights and the WebAssembly runtime all come off 1NKY's own origin (see
 * `public/models/README.md`), the detection runs in the page, and what gets
 * uploaded is the already-pixelated canvas. There is no "send us the photo and
 * we will blur it" step, because that step would be the leak.
 *
 * Pixelation rather than a Gaussian blur, on purpose. A blur is reversible-ish
 * to anyone with patience — it is a filter with a kernel — while averaging a
 * block of pixels down to one colour throws the information away for good. The
 * writer can also see, at a glance, that a hard mosaic covered the face; a soft
 * blur looks like it might not have.
 *
 * Everything above the `--- The tool ---` line is arithmetic with no DOM in it,
 * which is the half that can be tested.
 */

/** A rectangle in canvas pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How much bigger than the detection a covered box gets. */
export const BLUR_PAD = 0.3;

/** What the toggle says when the tool cannot be brought up on this device. */
export const BLUR_LOAD_FAILED = "Couldn't load the blur tool on this device.";

/** Where the vendored runtime and model sit. Never a CDN. */
export const BLUR_WASM_BASE = '/models/wasm';
export const BLUR_MODEL_PATH = '/models/blaze_face_short_range.tflite';

/**
 * Grow a detection box and keep it inside the picture.
 *
 * A face detector boxes the face; a writer wants the hair, the ears, the jaw and
 * the neck tattoo gone too, so every box grows by {@link BLUR_PAD} in each
 * direction about its own centre and is then clipped to the frame. Integers
 * throughout: these become `getImageData` arguments, and a fractional rectangle
 * is a rounding argument waiting to happen.
 */
export function padBox(
  box: Box,
  bounds: { width: number; height: number },
  pad: number = BLUR_PAD,
): Box {
  const grow = Math.max(0, pad);
  const width = box.width * (1 + grow);
  const height = box.height * (1 + grow);
  const centreX = box.x + box.width / 2;
  const centreY = box.y + box.height / 2;

  const left = Math.floor(Math.max(0, centreX - width / 2));
  const top = Math.floor(Math.max(0, centreY - height / 2));
  const right = Math.ceil(Math.min(bounds.width, centreX + width / 2));
  const bottom = Math.ceil(Math.min(bounds.height, centreY + height / 2));

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * How coarse the mosaic over a box should be.
 *
 * Scaled to the box rather than fixed, so a face filling the frame and a face in
 * the background both end up about six blocks across — which is the point at
 * which a face stops being a face. Never finer than 8px, because on a small
 * detection a fine mosaic is just a slightly soft face.
 */
export function blockSizeFor(box: Box): number {
  const shortest = Math.min(box.width, box.height);
  return Math.max(8, Math.round(shortest / 6));
}

/** The shape of an `ImageData`, minus the parts we do not touch. */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Average each block down to one colour, in place.
 *
 * Walks the region in `block`-sized squares, sums each channel, and paints the
 * mean back over the square. The last row and column are usually short; they are
 * averaged over whatever they actually contain rather than being skipped, so no
 * strip of real pixels survives along the edge of a box.
 */
export function pixelate(pixels: Pixels, block: number): void {
  const size = Math.max(1, Math.floor(block));
  const { data, width, height } = pixels;

  for (let top = 0; top < height; top += size) {
    for (let left = 0; left < width; left += size) {
      const right = Math.min(left + size, width);
      const bottom = Math.min(top + size, height);

      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let count = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const at = (y * width + x) * 4;
          red += data[at] ?? 0;
          green += data[at + 1] ?? 0;
          blue += data[at + 2] ?? 0;
          alpha += data[at + 3] ?? 0;
          count++;
        }
      }
      if (count === 0) continue;

      const meanRed = Math.round(red / count);
      const meanGreen = Math.round(green / count);
      const meanBlue = Math.round(blue / count);
      const meanAlpha = Math.round(alpha / count);
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const at = (y * width + x) * 4;
          data[at] = meanRed;
          data[at + 1] = meanGreen;
          data[at + 2] = meanBlue;
          data[at + 3] = meanAlpha;
        }
      }
    }
  }
}

/**
 * Just enough of a 2D context to cover a rectangle.
 *
 * A real `CanvasRenderingContext2D` satisfies this, and so does a plain object
 * over an array — which is how the covering gets tested without a browser.
 */
export interface PixelSurface {
  getImageData(x: number, y: number, width: number, height: number): Pixels;
  putImageData(pixels: Pixels, x: number, y: number): void;
}

/**
 * Cover every box on a surface. Returns the boxes as they were actually
 * applied — padded and clipped — which is what a caller draws outlines from.
 */
export function coverBoxes(
  surface: PixelSurface,
  boxes: readonly Box[],
  bounds: { width: number; height: number },
  pad: number = BLUR_PAD,
): Box[] {
  const applied: Box[] = [];
  for (const box of boxes) {
    const padded = padBox(box, bounds, pad);
    if (padded.width < 1 || padded.height < 1) continue;
    const region = surface.getImageData(padded.x, padded.y, padded.width, padded.height);
    pixelate(region, blockSizeFor(padded));
    surface.putImageData(region, padded.x, padded.y);
    applied.push(padded);
  }
  return applied;
}

/**
 * A square box around a tap, sized to the picture.
 *
 * The manual pass exists for the faces a detector misses — a face in profile, a
 * face behind a fence, a face on a poster in the background — and for anything
 * else the writer wants gone. One tap, one square: dragging a rectangle out on a
 * phone is a fight, and a square that is roughly head-sized is what is wanted
 * every time.
 */
export function boxAround(
  point: { x: number; y: number },
  bounds: { width: number; height: number },
  fraction = 0.18,
): Box {
  const side = Math.max(24, Math.round(Math.min(bounds.width, bounds.height) * fraction));
  return padBox(
    { x: point.x - side / 2, y: point.y - side / 2, width: side, height: side },
    bounds,
    0,
  );
}

/**
 * Read boxes out of whatever the detector handed back.
 *
 * Deliberately loose about the shape: this is the one place the library's own
 * types touch ours, and a detection with no usable rectangle on it is worth
 * stepping over rather than throwing away the whole pass for.
 */
export function detectionsToBoxes(result: unknown): Box[] {
  const detections = (result as { detections?: unknown } | null)?.detections;
  if (!Array.isArray(detections)) return [];

  const boxes: Box[] = [];
  for (const detection of detections) {
    const raw = (detection as { boundingBox?: Record<string, unknown> } | null)?.boundingBox;
    if (!raw) continue;
    const x = Number(raw['originX']);
    const y = Number(raw['originY']);
    const width = Number(raw['width']);
    const height = Number(raw['height']);
    if (![x, y, width, height].every((n) => Number.isFinite(n))) continue;
    if (width <= 0 || height <= 0) continue;
    boxes.push({ x, y, width, height });
  }
  return boxes;
}

// --- The tool ----------------------------------------------------------------

/** The sliver of the detector we use. */
export interface FaceFinder {
  detect(image: HTMLCanvasElement | HTMLImageElement | ImageBitmap): unknown;
  close?: () => void;
}

let pending: Promise<FaceFinder> | null = null;

/**
 * Bring the detector up, once, on first use.
 *
 * Loaded lazily for two reasons that point the same way: the runtime is a
 * multi-megabyte WebAssembly binary, and a writer who never touches the toggle
 * should never pay for it — in bytes, in battery, or in a request.
 *
 * A failure is remembered as a failure only for the attempt: the promise is
 * dropped on rejection so flipping the toggle again genuinely retries.
 */
export function loadFaceFinder(): Promise<FaceFinder> {
  pending ??= (async () => {
    const vision = await import('@mediapipe/tasks-vision');
    const fileset = await vision.FilesetResolver.forVisionTasks(BLUR_WASM_BASE);
    return (await vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: BLUR_MODEL_PATH },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.4,
    })) as unknown as FaceFinder;
  })().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

/** Test seam: forget any loaded (or failed) detector. */
export function resetFaceFinder(): void {
  pending = null;
}

/** Find the faces in a canvas. Never throws for "no faces". */
export async function findFaces(finder: FaceFinder, canvas: HTMLCanvasElement): Promise<Box[]> {
  return detectionsToBoxes(await finder.detect(canvas));
}

/**
 * Draw a picture into a canvas at a capped size, and hand back the size used.
 *
 * This is also, incidentally, the first half of the EXIF strip: decoded pixels
 * go into a fresh canvas and nothing else comes with them. The upload pipeline
 * re-encodes again afterwards, so the guarantee does not rest on this step —
 * but a blurred picture that still carried its GPS tag would be a bad joke.
 */
export async function drawInto(
  canvas: HTMLCanvasElement,
  source: Blob,
  maxEdge: number,
): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not read that picture.');
    context.drawImage(bitmap, 0, 0, width, height);
    return { width, height };
  } finally {
    bitmap.close();
  }
}

/** The canvas as it stands, as bytes ready to go up. */
export function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not read that picture.'))),
      'image/webp',
      quality,
    );
  });
}
