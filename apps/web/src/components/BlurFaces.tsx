import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BLUR_LOAD_FAILED,
  boxAround,
  canvasToBlob,
  coverBoxes,
  drawInto,
  findFaces,
  loadFaceFinder,
  type Box,
} from '../lib/blur.js';
import { FULL_MAX_EDGE, WEBP_QUALITY } from '../lib/config.js';

export interface BlurFacesProps {
  /** The picture the writer picked. Null clears everything. */
  file: File | null;
  /**
   * The bytes to upload instead of the picked file, or null to upload the file
   * itself. Called every time the covering changes.
   */
  onBlurred: (blob: Blob | null) => void;
  /**
   * True while the writer has asked for blurring that we cannot deliver. The
   * post screen refuses to put anything up until this is false — either the tool
   * comes up, or they switch it off themselves.
   */
  onBlocked: (blocked: boolean) => void;
}

/**
 * The "Blur faces" switch and its preview.
 *
 * Off by default: it is a choice, and a tool that quietly alters somebody's
 * picture is worse than no tool. When it is on, the writer looks at exactly the
 * pixels that are about to go up — the preview IS the upload, not an
 * approximation of it — and they can tap anything the detector missed.
 *
 * If the tool cannot be brought up, the switch says so and posting stays blocked
 * until the writer explicitly turns it off. That is the one place this component
 * is deliberately in the way: somebody who asked for faces to be covered must
 * never end up posting uncovered faces because a download failed.
 */
export function BlurFaces({ file, onBlurred, onBlocked }: BlurFacesProps): JSX.Element | null {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [found, setFound] = useState<Box[]>([]);
  const [tapped, setTapped] = useState<Box[]>([]);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  /**
   * Repaint the canvas from the original bytes and cover every box on it.
   *
   * Always from the original, never on top of the last pass: painting a mosaic
   * over a mosaic is how a covering slowly turns the whole picture to porridge,
   * and how removing a tapped box becomes impossible.
   */
  const repaint = useCallback(
    async (boxes: readonly Box[]): Promise<void> => {
      const node = canvas.current;
      if (!node || !file) return;
      const bounds = await drawInto(node, file, FULL_MAX_EDGE);
      setSize(bounds);
      const surface = node.getContext('2d');
      if (!surface) throw new Error('Could not read that picture.');
      coverBoxes(surface, boxes, bounds);
      onBlurred(await canvasToBlob(node, WEBP_QUALITY));
    },
    [file, onBlurred],
  );

  /** A fresh picture throws the last picture's boxes away. */
  useEffect(() => {
    setFound([]);
    setTapped([]);
    setSize(null);
    setFailed(false);
    onBlurred(null);
    onBlocked(false);
    setOn(false);
    // Intentionally keyed on the file alone: the callbacks are stable enough in
    // practice and re-running this on every render would clear the boxes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const switchOn = useCallback(async (): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setFailed(false);
    try {
      // The model comes down here and nowhere else — first flip only.
      const finder = await loadFaceFinder();
      const node = canvas.current;
      if (!node) throw new Error('Could not read that picture.');
      const bounds = await drawInto(node, file, FULL_MAX_EDGE);
      setSize(bounds);
      const faces = await findFaces(finder, node);
      setFound(faces);
      setTapped([]);
      await repaint(faces);
      onBlocked(false);
    } catch {
      setFailed(true);
      setFound([]);
      setTapped([]);
      onBlurred(null);
      // Asked for, not delivered: hold the door until they decide.
      onBlocked(true);
    } finally {
      setBusy(false);
    }
  }, [file, repaint, onBlurred, onBlocked]);

  const switchOff = useCallback((): void => {
    setFailed(false);
    setFound([]);
    setTapped([]);
    onBlurred(null);
    onBlocked(false);
  }, [onBlurred, onBlocked]);

  const flip = (next: boolean): void => {
    setOn(next);
    if (next) void switchOn();
    else switchOff();
  };

  /** Tap the preview to cover something the detector walked past. */
  const tap = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    const node = canvas.current;
    if (!node || !size || busy) return;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const point = {
      x: ((event.clientX - rect.left) / rect.width) * size.width,
      y: ((event.clientY - rect.top) / rect.height) * size.height,
    };
    const next = [...tapped, boxAround(point, size)];
    setTapped(next);
    void repaint([...found, ...next]);
  };

  const undoTap = (): void => {
    const next = tapped.slice(0, -1);
    setTapped(next);
    void repaint([...found, ...next]);
  };

  if (!file || !file.type.startsWith('image/')) return null;

  return (
    <section className="stack">
      <label className={`toggle ${on ? 'toggle--on' : ''}`}>
        <span className="toggle__box" aria-hidden="true" />
        <input
          type="checkbox"
          className="sr-only"
          checked={on}
          onChange={(event) => flip(event.target.checked)}
        />
        Blur faces
      </label>

      {failed ? (
        <>
          <p className="error">{BLUR_LOAD_FAILED}</p>
          <p className="help">
            Switch it back off to put this up without it, or try again on another connection.
          </p>
        </>
      ) : (
        <p className="help">
          {on
            ? 'This is exactly what goes up. Tap anything it missed.'
            : 'Covers faces on this device before anything is sent. Off unless you ask for it.'}
        </p>
      )}

      {/* The canvas stays mounted whenever the switch is on: it is both the
          preview and the thing that gets uploaded. */}
      <div className={on && !failed ? 'blur-stage' : 'sr-only'}>
        <canvas ref={canvas} className="preview blur-stage__canvas" onClick={tap} />
      </div>

      {on && !failed ? (
        <div className="row spread">
          <span className="mono faint">
            {busy
              ? 'looking...'
              : found.length === 0 && tapped.length === 0
                ? 'no faces found — tap any you want covered'
                : `${found.length + tapped.length} covered`}
          </span>
          {tapped.length > 0 ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={undoTap}>
              Undo last
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
