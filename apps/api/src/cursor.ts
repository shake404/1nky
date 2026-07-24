/**
 * Keyset pagination cursors.
 *
 * The feed is ordered by `(created_at, event_id) desc`, so a cursor is exactly
 * that pair. Offset pagination would drift as new flicks land at the top and
 * would make the client re-see rows; keyset pagination cannot.
 *
 * The encoding is base64url of `<created_at>.<event_id>`. It is opaque to the
 * client but deliberately not signed or encrypted: it carries nothing that is
 * not already in the response body.
 */

export interface Cursor {
  createdAt: number;
  eventId: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}.${cursor.eventId}`, 'utf8').toString('base64url');
}

/** Returns null for anything malformed — a bad cursor is a 400, not a crash. */
export function decodeCursor(raw: string): Cursor | null {
  if (typeof raw !== 'string' || raw === '' || raw.length > 256) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const dot = decoded.indexOf('.');
  if (dot <= 0) return null;

  const createdAt = Number(decoded.slice(0, dot));
  const eventId = decoded.slice(dot + 1);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) return null;
  if (!HEX64.test(eventId)) return null;

  return { createdAt, eventId };
}

/**
 * The cursor for the next page, or null when this page is the last one.
 * A page shorter than `limit` means there is nothing after it.
 */
export function nextCursor(
  rows: readonly { created_at: number | string; event_id: string }[],
  limit: number,
): string | null {
  if (rows.length < limit || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  if (!last) return null;
  const createdAt =
    typeof last.created_at === 'number' ? last.created_at : Number.parseInt(last.created_at, 10);
  if (!Number.isFinite(createdAt)) return null;
  return encodeCursor({ createdAt, eventId: last.event_id });
}
