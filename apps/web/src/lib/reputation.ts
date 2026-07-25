/**
 * Standing, 1NKY style.
 *
 * There are no scores here, no karma, no ranks, no badges anybody can farm.
 * Standing is two plain facts a writer can check for themselves:
 *
 *   1. how long they have been on the wall, and
 *   2. how much they have up.
 *
 * That is the whole model, and it is deliberately unflattering: a fresh tag
 * reads as fresh, and the only cure is time and work. Everything in this file is
 * pure so both facts can be pinned by tests and rendered without a round trip.
 */

const DAY = 86_400;

/** Day thresholds for the dots: under a week, under a month, under six months. */
export const AGE_DOT_THRESHOLDS = [7, 30, 180] as const;

/** How many dots the row can ever show. */
export const AGE_DOT_MAX = 3;

export interface WallAge {
  /** Whole days since they first turned up. */
  days: number;
  /** 0–3 filled dots. Nobody starts with one. */
  dots: 0 | 1 | 2 | 3;
  /** What a reader hears instead of seeing the dots: "up for 3 months". */
  label: string;
}

function seconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

/** Plain "3 days" / "1 month" / "2 years", never an abbreviation. */
function spell(count: number, unit: string): string {
  return `${count} ${count === 1 ? unit : `${unit}s`}`;
}

/**
 * How long somebody has been on the wall.
 *
 * Returns null when the wall does not know — a tag nobody has seen post yet, or
 * an older box that never recorded it. Null means SAY NOTHING: an invented
 * "brand new" claim would be a guess dressed up as a fact.
 */
export function wallAge(
  firstSeen: number | null | undefined,
  now: number = Math.floor(Date.now() / 1000),
): WallAge | null {
  const since = seconds(firstSeen);
  if (since === null) return null;

  const days = Math.max(0, Math.floor((now - since) / DAY));

  const [week, month, half] = AGE_DOT_THRESHOLDS;
  const dots: 0 | 1 | 2 | 3 = days < week ? 0 : days < month ? 1 : days < half ? 2 : 3;

  let label: string;
  if (days < 1) label = 'up since today';
  else if (days < month) label = `up for ${spell(days, 'day')}`;
  else if (days < 365) label = `up for ${spell(Math.floor(days / 30), 'month')}`;
  else label = `up for ${spell(Math.floor(days / 365), 'year')}`;

  return { days, dots, label };
}

/**
 * Month names spelled out here rather than through `toLocaleDateString`, so the
 * line reads the same on every device and can be pinned by a test.
 */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * "on the wall since March 2025" — the header line on a writer's page.
 *
 * Month and year only. A day-precision date is a timeline of somebody's
 * movements and this app does not build those.
 */
export function onTheWallSince(firstSeen: number | null | undefined): string | null {
  const since = seconds(firstSeen);
  if (since === null) return null;
  const when = new Date(since * 1000);
  const month = MONTHS[when.getMonth()];
  if (!month) return null;
  return `on the wall since ${month} ${when.getFullYear()}`;
}

/**
 * "12 up" — how much a writer has put up.
 *
 * Null for nothing and for an uncounted wall alike: the empty state under the
 * header already says there is nothing there, and a bare "0 up" on somebody's
 * page reads like a mark against them rather than a fact.
 */
export function upLine(count: number | null | undefined): string | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) return null;
  return `${Math.floor(count)} up`;
}
