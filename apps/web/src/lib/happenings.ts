import { HAPPENING_BOARD, HAPPENING_GRACE_SECONDS } from '@1nky/protocol';
import { API_BASE } from './config.js';
import { threadRowFrom, type ThreadRow } from './boards.js';
import { isIgnored } from './mute.js';

/**
 * What is coming up — jams, meets, shows.
 *
 * A happening is not a new kind of thing: it is a thread somebody put a date
 * on, so it has a board, replies, a writer and a clock exactly like any other
 * thread and everything in `boards.ts` already works on it. The only two new
 * facts are the date it goes down and the fact that the wall clears it a week
 * after that, and both live here.
 *
 * Nothing in this file writes. Putting a happening up is
 * `postThread({ happeningAt })`, which is the ordinary thread path.
 */

/**
 * How long a happening stays readable after it goes down, and the marker slug
 * that makes a thread one. Both come from the shared builders — the wall, the
 * indexer and this client have to agree on them or the list is wrong.
 */
export { HAPPENING_BOARD, HAPPENING_GRACE_SECONDS };

/** The one line that explains what becomes of a happening. */
export const HAPPENING_CLEARS_COPY = 'clears itself a week after';

/** A row on the happenings list: a thread row, plus the date and its boards. */
export interface Happening extends ThreadRow {
  /** When it goes down. Never null here — that is what makes it a happening. */
  happeningAt: number;
  /** The boards it went up on, marker slug included. */
  boards: string[];
}

export interface HappeningsPage {
  happenings: Happening[];
  cursor: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function happeningFrom(value: unknown): Happening | null {
  const row = threadRowFrom(value);
  // A row with no date could not have come from this list, so a missing one is
  // a row we do not understand rather than an ordinary thread to show anyway.
  if (!row || row.happeningAt === null || row.happeningAt <= 0) return null;
  const raw = record(value);
  const rawBoards = raw?.['boards'];
  const boards = (Array.isArray(rawBoards) ? rawBoards : [])
    .map((b) => (typeof b === 'string' ? b.trim().toLowerCase() : ''))
    .filter((b) => b.length > 0);
  return { ...row, happeningAt: row.happeningAt, boards };
}

/**
 * Read whatever `GET /happenings` handed back.
 *
 * Ignored writers disappear here, the same way they disappear from a board's
 * thread list — doing it at the shaping step means no screen has to remember.
 */
export function parseHappeningsResponse(payload: unknown): HappeningsPage {
  const body = record(payload) ?? {};
  const rawList = body['happenings'];
  const list = Array.isArray(rawList) ? rawList : [];
  const happenings = list
    .map(happeningFrom)
    .filter((h): h is Happening => h !== null && !isIgnored(h.writer.pubkey));
  const cursor = typeof body['nextCursor'] === 'string' ? body['nextCursor'] : '';
  return { happenings, cursor: cursor || null };
}

export interface HappeningsRequest {
  /** City slug to narrow to. Omit for everywhere. */
  city?: string;
  cursor?: string | null;
  limit?: number;
}

/** `GET /happenings?city=&cursor=&limit=` — soonest first. */
export async function fetchHappenings(
  request: HappeningsRequest = {},
  signal?: AbortSignal,
): Promise<HappeningsPage> {
  const url = new URL(`${API_BASE}/happenings`);
  if (request.city) url.searchParams.set('city', request.city);
  url.searchParams.set('limit', String(request.limit ?? 30));
  if (request.cursor) url.searchParams.set('cursor', request.cursor);

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error('unavailable');
  return parseHappeningsResponse(await response.json());
}

// --- Saying when -------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * "Sat Aug 1", with the year only when it is not this one.
 *
 * Written out by hand rather than handed to `toLocaleDateString`, because the
 * comma-and-full-stop shapes a locale picks read as a receipt; a flyer says
 * "SAT AUG 1".
 */
function dayText(when: Date, today: Date): string {
  const base = `${WEEKDAYS[when.getDay()]} ${MONTHS[when.getMonth()]} ${when.getDate()}`;
  return when.getFullYear() === today.getFullYear() ? base : `${base} ${when.getFullYear()}`;
}

/** "8pm", "8:30pm", or nothing at all when the date carries no time of day. */
function clockText(when: Date): string {
  const hours = when.getHours();
  const minutes = when.getMinutes();
  if (hours === 0 && minutes === 0) return '';
  const suffix = hours < 12 ? 'am' : 'pm';
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  return minutes === 0
    ? `${hour}${suffix}`
    : `${hour}:${String(minutes).padStart(2, '0')}${suffix}`;
}

/** "Sat Aug 1" or "Sat Aug 1, 8pm" — the date on the flyer. */
export function whenText(happeningAt: number, now: number = Math.floor(Date.now() / 1000)): string {
  const when = new Date(happeningAt * 1000);
  const today = new Date(now * 1000);
  const clock = clockText(when);
  const day = dayText(when, today);
  return clock ? `${day}, ${clock}` : day;
}

/** The one line the thread page carries: when it runs and when it goes away. */
export function runsLine(happeningAt: number, now: number = Math.floor(Date.now() / 1000)): string {
  return `runs ${whenText(happeningAt, now)} · gone a week after`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Which heading a happening sits under.
 *
 * Buckets in the order a writer thinks in: today, tomorrow, the weekend that is
 * coming, next week, and after that just the date. Weekday dates inside this
 * week get their own date heading rather than being swept into "this week",
 * because "Wednesday" is the useful word and the list is already in order.
 *
 * The week runs Monday to Sunday, so "this weekend" is the Saturday and Sunday
 * at the end of the week we are standing in — on a Sunday there is no weekend
 * left to point at and the next one lands in "next week", which is true.
 */
export function happeningGroup(
  happeningAt: number,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const when = new Date(happeningAt * 1000);
  const today = new Date(now * 1000);
  const days = Math.round((startOfDay(when) - startOfDay(today)) / 86_400_000);

  if (days < 0) return 'under way';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';

  // Monday = 0 … Sunday = 6, so this is how many days of the week are left.
  const daysLeftThisWeek = 6 - ((today.getDay() + 6) % 7);
  const dow = when.getDay();
  if (days <= daysLeftThisWeek) {
    return dow === 0 || dow === 6 ? 'this weekend' : dayText(when, today);
  }
  if (days <= daysLeftThisWeek + 7) return 'next week';
  return dayText(when, today);
}

export interface HappeningGroup {
  label: string;
  happenings: Happening[];
}

/**
 * Sort the list into its headings, keeping the order it arrived in.
 *
 * The wall hands these back soonest-first, so walking them in order puts the
 * headings in order too. A label that turns up again later joins the group it
 * already has rather than opening a second one with the same name.
 */
export function groupHappenings(
  happenings: readonly Happening[],
  now: number = Math.floor(Date.now() / 1000),
): HappeningGroup[] {
  const groups = new Map<string, Happening[]>();
  for (const happening of happenings) {
    const label = happeningGroup(happening.happeningAt, now);
    const bucket = groups.get(label);
    if (bucket) bucket.push(happening);
    else groups.set(label, [happening]);
  }
  return [...groups].map(([label, items]) => ({ label, happenings: items }));
}
