import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Square avatar cropper.
 *
 * Hands back a clean square image the writer actually framed, instead of a
 * blind centre-crop. The picture is drawn onto a canvas flattened over the
 * wall's own dark — so a transparent PNG sits on soot, never the ink pink —
 * which also strips every trace of metadata (the canvas re-encode is the
 * EXIF kill the flick pipeline relies on, done here before anything uploads).
 *
 * Drag to move it, the slider to size it. The frame is always covered: you
 * are choosing which part shows, never leaving a gap.
 */

const STAGE = 260; // on-screen crop square, CSS px
const OUT = 512; // exported square, device px
const SOOT = '#0c0a11';
const MAX_ZOOM = 4;

/**
 * The scale at which an `iw`×`ih` image just covers a `stage`×`stage` square
 * (object-fit: cover). Zoom multiplies on top of this, so the frame is never
 * left with a gap. Pure — exported for tests.
 */
export function coverBase(iw: number, ih: number, stage: number): number {
  if (iw <= 0 || ih <= 0) return 1;
  return Math.max(stage / iw, stage / ih);
}

/** Clamp a top-left offset so a `drawW`×`drawH` image still covers `stage`. */
export function clampOffset(v: number, draw: number, stage: number): number {
  return Math.min(0, Math.max(stage - draw, v));
}

export interface AvatarCropperProps {
  /** The freshly-picked file to frame. */
  file: File;
  /** Called with the framed square as a webp blob. */
  onDone: (blob: Blob) => void;
  /** Called when the writer backs out without framing. */
  onCancel: () => void;
}

interface Frame {
  img: HTMLImageElement;
  base: number; // scale at which the image just covers the stage
}

export function AvatarCropper({ file, onDone, onCancel }: AvatarCropperProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<Frame | null>(null);
  const offset = useRef({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  const [zoom, setZoom] = useState(1);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /** Clamp the offset so the scaled image always covers the stage. */
  const clamp = useCallback((z: number): void => {
    const frame = frameRef.current;
    if (!frame) return;
    const drawW = frame.img.width * frame.base * z;
    const drawH = frame.img.height * frame.base * z;
    offset.current.x = clampOffset(offset.current.x, drawW, STAGE);
    offset.current.y = clampOffset(offset.current.y, drawH, STAGE);
  }, []);

  /** Paint the on-screen preview at the current offset + zoom. */
  const paint = useCallback(
    (z: number): void => {
      const canvas = canvasRef.current;
      const frame = frameRef.current;
      if (!canvas || !frame) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const drawW = frame.img.width * frame.base * z;
      const drawH = frame.img.height * frame.base * z;
      ctx.fillStyle = SOOT;
      ctx.fillRect(0, 0, STAGE, STAGE);
      ctx.drawImage(frame.img, offset.current.x, offset.current.y, drawW, drawH);
    },
    [],
  );

  useEffect(() => {
    let live = true;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (!live) return;
      const base = coverBase(img.width, img.height, STAGE);
      frameRef.current = { img, base };
      // Start centred.
      offset.current = {
        x: (STAGE - img.width * base) / 2,
        y: (STAGE - img.height * base) / 2,
      };
      setReady(true);
      setZoom(1);
      paint(1);
    };
    img.onerror = () => {
      if (live) setError('Could not read that picture.');
    };
    img.src = url;
    return () => {
      live = false;
      URL.revokeObjectURL(url);
    };
  }, [file, paint]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!drag.current) return;
    offset.current.x += e.clientX - drag.current.x;
    offset.current.y += e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    clamp(zoom);
    paint(zoom);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onZoom = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const next = Number(e.target.value);
    // Keep the stage centre fixed as it scales, so zooming feels anchored.
    const frame = frameRef.current;
    if (frame) {
      const cx = STAGE / 2;
      const cy = STAGE / 2;
      const ratio = next / zoom;
      offset.current.x = cx - (cx - offset.current.x) * ratio;
      offset.current.y = cy - (cy - offset.current.y) * ratio;
    }
    setZoom(next);
    clamp(next);
    paint(next);
  };

  const confirm = async (): Promise<void> => {
    const frame = frameRef.current;
    if (!frame) return;
    setBusy(true);
    try {
      const out = document.createElement('canvas');
      out.width = OUT;
      out.height = OUT;
      const ctx = out.getContext('2d');
      if (!ctx) throw new Error('no canvas');
      const k = OUT / STAGE;
      const drawW = frame.img.width * frame.base * zoom * k;
      const drawH = frame.img.height * frame.base * zoom * k;
      ctx.fillStyle = SOOT;
      ctx.fillRect(0, 0, OUT, OUT);
      ctx.drawImage(frame.img, offset.current.x * k, offset.current.y * k, drawW, drawH);
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/webp', 0.9));
      if (!blob) throw new Error('Could not save that picture.');
      onDone(blob);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not save that picture.');
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="cropper">
        <p className="error">{error}</p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Pick another
        </button>
      </div>
    );
  }

  return (
    <div className="cropper">
      <p className="help" style={{ marginTop: 0 }}>Drag to move it. Slide to size it.</p>
      <canvas
        ref={canvasRef}
        width={STAGE}
        height={STAGE}
        className="cropper__stage"
        style={{ width: STAGE, height: STAGE, touchAction: 'none', cursor: ready ? 'grab' : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-label="Position your picture"
      />
      <input
        type="range"
        min={1}
        max={MAX_ZOOM}
        step={0.01}
        value={zoom}
        onChange={onZoom}
        disabled={!ready || busy}
        aria-label="Zoom"
        className="cropper__zoom"
      />
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn--go btn--sm sticker" onClick={() => void confirm()} disabled={!ready || busy}>
          Use this
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>
          Never mind
        </button>
      </div>
    </div>
  );
}
