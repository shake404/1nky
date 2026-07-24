import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';

/**
 * Renders a payload as a QR straight onto a canvas.
 *
 * Encoding happens in this tab — nothing is sent anywhere to make the
 * picture. Used for blackbook export and for linking a second device.
 */
export function QrBlock({ value, size = 220 }: { value: string; size?: number }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    setFailed(false);
    QRCode.toCanvas(canvas, value, {
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0d0d0dff', light: '#f4f2edff' },
    }).catch(() => setFailed(true));
  }, [value, size]);

  return (
    <div className="qr">
      <canvas ref={ref} width={size} height={size} aria-label="Scannable block" />
      {failed ? <p className="error">Too long to show as a block. Use the file.</p> : null}
    </div>
  );
}
