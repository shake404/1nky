import { useState } from 'react';
import { MEDIA_BASE } from '../lib/config.js';
import { Identicon } from './Identicon.js';

const HEX64 = /^[0-9a-f]{64}$/;

interface Props {
  /** The writer (or crew) this avatar belongs to — drives the fallback mark. */
  pubkey: string;
  /** The picture's blob address, when they have set one. */
  avatarSha256?: string | null;
  size?: number;
  alt?: string;
}

/**
 * The pictorial avatar: their chosen picture when they have one, the
 * deterministic block-mark ({@link Identicon}) when they do not.
 *
 * This is the ONE place that decides picture-vs-mark. A missing, empty or
 * malformed address falls back to the mark; so does a picture that fails to
 * load (`onError`) — a broken image must never sit where a recognisable mark
 * would. Square and hard-edged to sit in the identicon's exact footprint, per
 * the app's look.
 */
export function Avatar({ pubkey, avatarSha256, size = 22, alt = '' }: Props): JSX.Element {
  // Track failure per-address: a new picture resets the fallback on its own,
  // because `failedSrc !== sha` becomes true again the moment `sha` changes.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const sha = (avatarSha256 ?? '').toLowerCase();

  if (!HEX64.test(sha) || failedSrc === sha) {
    return <Identicon pubkey={pubkey} size={size} />;
  }

  return (
    <img
      className="avatar"
      src={`${MEDIA_BASE}/${sha}`}
      alt={alt}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      onError={() => setFailedSrc(sha)}
    />
  );
}
