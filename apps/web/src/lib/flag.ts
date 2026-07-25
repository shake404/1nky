import { buildReport, REPORT_REASONS, type ReportReason, type SignedEvent } from '@1nky/protocol';
import { POW_BITS } from './config.js';
import type { Tag } from './identity.js';
import { publishTemplate, type PublishOptions } from './publish.js';

/**
 * "Flag it" — a writer handing a post to whoever is watching the queue.
 *
 * The wire reasons are fixed (NIP-56 vocabulary, seven of them). Nobody has to
 * read that vocabulary: every one of them gets a label in the interface's own
 * voice, and the picker is built from this table so a new reason can never
 * show up unlabelled.
 */

export interface FlagChoice {
  /** The wire value. Never shown. */
  reason: ReportReason;
  /** What the writer actually reads. */
  label: string;
}

export const FLAG_CHOICES: readonly FlagChoice[] = Object.freeze([
  { reason: 'illegal', label: 'Straight-up illegal' },
  { reason: 'nudity', label: 'Nudity' },
  { reason: 'spam', label: 'Spam' },
  { reason: 'impersonation', label: 'Biting / impersonation' },
  { reason: 'malware', label: 'Sketchy file' },
  { reason: 'profanity', label: 'Slurs' },
  { reason: 'other', label: 'Something else' },
] as const satisfies readonly FlagChoice[]);

/** Longest note we accept. One line, not an essay. */
export const FLAG_NOTE_MAX = 140;

/** The label for a wire reason — falls back to the catch-all label. */
export function flagLabel(reason: string): string {
  const found = FLAG_CHOICES.find((choice) => choice.reason === reason);
  return found?.label ?? 'Something else';
}

/** Every wire reason has exactly one label, and there are no strays. */
export function flagChoicesCoverEveryReason(): boolean {
  const labelled = FLAG_CHOICES.map((choice) => choice.reason);
  return (
    labelled.length === REPORT_REASONS.length &&
    REPORT_REASONS.every((reason) => labelled.includes(reason))
  );
}

export interface FlagTarget {
  /** The writer who put it up. */
  pubkey: string;
  /** The post being flagged. */
  eventId: string;
  /** Whether it was a picture or a clip, so the queue can render it. */
  kind: number;
}

/**
 * Put a flag up. Cheap tier — flagging has to stay effectively free or the
 * only people who bother are the ones with time to burn.
 */
export function flagIt(
  tag: Pick<Tag, 'secret' | 'pubkey'>,
  target: FlagTarget,
  reason: ReportReason,
  options: PublishOptions & { note?: string } = {},
): Promise<SignedEvent> {
  const note = options.note?.trim().slice(0, FLAG_NOTE_MAX) ?? '';
  const template = buildReport(
    { pubkey: target.pubkey, eventId: target.eventId, kind: target.kind },
    reason,
    note ? { note } : {},
  );
  return publishTemplate(tag.secret, tag.pubkey, template, POW_BITS.reaction, options);
}
