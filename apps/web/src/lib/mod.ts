import { buildModBan, fingerprint, KINDS, type SignedEvent } from '@1nky/protocol';
import { API_BASE, POW_BITS } from './config.js';
import { getPref, setPref } from './db.js';
import type { Tag } from './identity.js';
import { ago } from './platform.js';
import { buffEvents, publishTemplate, type PublishOptions } from './publish.js';

/**
 * The mod console's data layer.
 *
 * Reads are plain GETs against the read API, gated by a shared secret the mod
 * pastes in once and this device keeps. Writes are NOT requests at all: a
 * takedown and a ban are both signed events the mod puts up with their own
 * tag, exactly like any other post. The server only acts on them when that
 * tag is on its short list of mods, which is what makes the whole moderation
 * log auditable after the fact.
 */

const MOD_KEY_PREF = 'modKey';
const DISMISSED_PREF = 'modDismissed';
/** How many dismissals we remember. Old ones fall off; the queue re-ages anyway. */
const DISMISSED_CAP = 500;

// --- The key -----------------------------------------------------------------

export async function loadModKey(): Promise<string> {
  const stored = await getPref<string>(MOD_KEY_PREF, '');
  return typeof stored === 'string' ? stored : '';
}

export async function saveModKey(key: string): Promise<void> {
  await setPref(MOD_KEY_PREF, key.trim());
}

export async function forgetModKey(): Promise<void> {
  await setPref(MOD_KEY_PREF, '');
}

// --- Locally hidden reports --------------------------------------------------

export async function loadDismissed(): Promise<string[]> {
  const stored = await getPref<unknown[]>(DISMISSED_PREF, []);
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
}

/** "Leave it" — hide one report on this device without touching the wall. */
export async function dismissReport(id: string): Promise<string[]> {
  const current = await loadDismissed();
  if (current.includes(id)) return current;
  const next = [id, ...current].slice(0, DISMISSED_CAP);
  await setPref(DISMISSED_PREF, next);
  return next;
}

// --- Shapes ------------------------------------------------------------------

export interface Reporter {
  pubkey: string;
  mark: string;
  /** When this writer first showed up, or null if we cannot tell. */
  firstEventAt: number | null;
  eventCount: number;
  /** Flags raised *against* the reporter. A pile of them is worth a look. */
  reportCount: number;
}

export interface FlaggedTarget {
  pubkey: string | null;
  tag: string | null;
  mark: string | null;
  eventId: string | null;
  kind: number | null;
  content: string;
  createdAt: number | null;
  thumbnailUrl: string | null;
  blurhash: string | null;
  boards: string[];
  reportCount: number;
  banned: boolean;
  /** False when the flagged post is already gone. The flag stays as a record. */
  present: boolean;
}

export interface ModReport {
  id: string;
  createdAt: number;
  /** Wire reason; render it through `flagLabel`. */
  reason: string;
  note: string;
  reporter: Reporter;
  target: FlaggedTarget;
}

export interface BannedWriter {
  pubkey: string;
  mark: string;
  reason: string | null;
  bannedAt: number;
  bannedBy: string | null;
  reportCount: number;
  eventCount: number;
}

// --- Errors ------------------------------------------------------------------

export type ModFailure = 'badkey' | 'off' | 'unreachable';

/** Every message here is already the thing to show on screen. */
export class ModError extends Error {
  readonly failure: ModFailure;

  constructor(failure: ModFailure) {
    super(MOD_ERROR_COPY[failure]);
    this.failure = failure;
  }
}

const MOD_ERROR_COPY: Record<ModFailure, string> = {
  badkey: "That key doesn't work.",
  off: 'Mod tools are switched off on the server.',
  unreachable: 'Could not reach the wall. Check your connection and try again.',
};

/**
 * "3d on the wall" — how long the writer raising a flag has been around.
 *
 * A brand-new tag raising flags reads very differently from one that has been
 * putting work up for a year, so the queue says it plainly next to the mark.
 */
export function reporterAge(firstEventAt: number | null): string {
  if (firstEventAt === null || firstEventAt <= 0) return 'brand new';
  const since = ago(firstEventAt);
  if (since === 'just now') return 'brand new';
  return `${since} on the wall`;
}

// --- Reads -------------------------------------------------------------------

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableStr(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

async function readMod(path: string, key: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: 'application/json', 'X-Mod-Key': key },
    });
  } catch {
    throw new ModError('unreachable');
  }
  if (response.status === 401 || response.status === 403) throw new ModError('badkey');
  if (response.status === 503) throw new ModError('off');
  if (!response.ok) throw new ModError('unreachable');
  try {
    return await response.json();
  } catch {
    throw new ModError('unreachable');
  }
}

export function shapeReports(payload: unknown): ModReport[] {
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const rows = Array.isArray(body['reports']) ? body['reports'] : [];
  const out: ModReport[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const id = str(record['id']);
    if (!id) continue;

    const reporterRaw = record['reporter'];
    const reporter = (typeof reporterRaw === 'object' && reporterRaw !== null ? reporterRaw : {}) as Record<string, unknown>;
    const reporterPubkey = str(reporter['pubkey']);

    const targetRaw = record['target'];
    const target = (typeof targetRaw === 'object' && targetRaw !== null ? targetRaw : {}) as Record<string, unknown>;
    const targetPubkey = nullableStr(target['pubkey']);

    out.push({
      id,
      createdAt: num(record['createdAt']),
      reason: str(record['reason'], 'other') || 'other',
      note: str(record['note']),
      reporter: {
        pubkey: reporterPubkey,
        mark: str(reporter['mark']) || (reporterPubkey ? fingerprint(reporterPubkey) : ''),
        firstEventAt: nullableNum(reporter['firstEventAt']),
        eventCount: num(reporter['eventCount']),
        reportCount: num(reporter['reportCount']),
      },
      target: {
        pubkey: targetPubkey,
        tag: nullableStr(target['tag']),
        mark: nullableStr(target['mark']) ?? (targetPubkey ? fingerprint(targetPubkey) : null),
        eventId: nullableStr(target['eventId']),
        kind: nullableNum(target['kind']),
        content: str(target['content']),
        createdAt: nullableNum(target['createdAt']),
        thumbnailUrl: nullableStr(target['thumbnailUrl']),
        blurhash: nullableStr(target['blurhash']),
        boards: Array.isArray(target['boards'])
          ? (target['boards'] as unknown[]).filter((b): b is string => typeof b === 'string')
          : [],
        reportCount: num(target['reportCount']),
        banned: target['banned'] === true,
        present: target['present'] !== false,
      },
    });
  }
  return out;
}

export function shapeBanlist(payload: unknown): BannedWriter[] {
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const rows = Array.isArray(body['banned']) ? body['banned'] : [];
  const out: BannedWriter[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const pubkey = str(record['pubkey']);
    if (!pubkey) continue;
    out.push({
      pubkey,
      mark: str(record['mark']) || fingerprint(pubkey),
      reason: nullableStr(record['reason']),
      bannedAt: num(record['bannedAt']),
      bannedBy: nullableStr(record['bannedBy']),
      reportCount: num(record['reportCount']),
      eventCount: num(record['eventCount']),
    });
  }
  return out;
}

export async function fetchModQueue(key: string, limit = 50): Promise<ModReport[]> {
  return shapeReports(await readMod(`/mod/queue?limit=${encodeURIComponent(String(limit))}`, key));
}

export async function fetchBanlist(key: string): Promise<BannedWriter[]> {
  return shapeBanlist(await readMod('/mod/banlist', key));
}

// --- Writes (signed events, put up with the mod's own tag) -------------------

/**
 * Take one post down.
 *
 * Same kind-5 a writer uses to buff their own work; the server honours it
 * against somebody else's post only from a tag on its mod list.
 */
export function takeDown(
  tag: Tag,
  eventId: string,
  kind: number | null,
  options: PublishOptions = {},
): Promise<SignedEvent> {
  return buffEvents(tag, [eventId], [kind ?? KINDS.FLICK], options);
}

/** Stop a writer from putting anything else up. */
export function banWriter(
  tag: Pick<Tag, 'secret' | 'pubkey'>,
  pubkey: string,
  reason: string | null,
  options: PublishOptions = {},
): Promise<SignedEvent> {
  const template = buildModBan(pubkey, 'ban', reason ? { reason } : {});
  return publishTemplate(tag.secret, tag.pubkey, template, POW_BITS.post, options);
}

/** Let them back on the wall. Replaces the ban outright. */
export function unbanWriter(
  tag: Pick<Tag, 'secret' | 'pubkey'>,
  pubkey: string,
  options: PublishOptions = {},
): Promise<SignedEvent> {
  return publishTemplate(tag.secret, tag.pubkey, buildModBan(pubkey, 'unban'), POW_BITS.post, options);
}

/**
 * One tap: the post comes down, then the writer is stopped.
 *
 * Order matters. The takedown goes first so that if the second half fails the
 * bad post is already gone — the reverse would leave it up while looking done.
 */
export async function takeDownAndBan(
  tag: Tag,
  report: ModReport,
  options: PublishOptions = {},
): Promise<void> {
  if (report.target.eventId && report.target.present) {
    await takeDown(tag, report.target.eventId, report.target.kind, options);
  }
  if (report.target.pubkey) {
    await banWriter(tag, report.target.pubkey, report.reason, options);
  }
}
