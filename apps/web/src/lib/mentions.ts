import { fingerprint } from '@1nky/protocol';
import type { ThreadReply, ThreadView } from './boards.js';

/**
 * @-mentions, the privacy-safe way.
 *
 * There is no global directory of writers to autocomplete against — that would
 * be a map of who exists, which this place deliberately does not keep. So the
 * only writers you can @ are the ones already in front of you: the writer who
 * put a thread up and everyone who has said something under it. That pool is
 * public by the act of posting, needs no lookup, and can never leak a writer
 * who was not already on the screen.
 *
 * Everything here is pure text work — collect the pool, find what an @token is
 * reaching for, drop a pick into the draft, and read back which of the pool a
 * finished draft actually names. The event side (turning a named writer into a
 * real `p` tag) is `buildComment`'s job; this only decides *who*.
 */

/** One writer you could @ — the shape the typeahead and the p-tag pass share. */
export interface MentionCandidate {
  pubkey: string;
  /** Their tag name, when the wall joined it in. Null falls back to the mark. */
  tag: string | null;
  mark: string;
}

/** How many suggestions the dropdown shows at once. */
export const MENTION_LIMIT = 6;

/** The handle an @token uses for a candidate: their tag, or their mark. */
export function mentionHandle(candidate: MentionCandidate): string {
  return candidate.tag?.trim() || candidate.mark;
}

function pushCandidate(
  out: MentionCandidate[],
  seen: Set<string>,
  writer: { pubkey: string; tag: string | null; mark?: string },
): void {
  const pubkey = writer.pubkey.toLowerCase();
  if (!pubkey || seen.has(pubkey)) return;
  seen.add(pubkey);
  out.push({
    pubkey,
    tag: writer.tag?.trim() ? writer.tag.trim() : null,
    // Never depend on a mark the wall may not have sent — it is derived from
    // the pubkey and we always hold that.
    mark: writer.mark?.trim() || fingerprint(pubkey),
  });
}

/**
 * Everyone in a thread you could @: the opening post's writer plus every
 * writer with a comment anywhere in the tree, deduped by pubkey. The current
 * writer is kept in the pool — @-ing yourself is harmless and simpler than a
 * special case, and the composer never knows whose device it is anyway.
 */
export function collectParticipants(view: ThreadView): MentionCandidate[] {
  const out: MentionCandidate[] = [];
  const seen = new Set<string>();
  pushCandidate(out, seen, view.thread.writer);
  const walk = (nodes: readonly ThreadReply[]): void => {
    for (const node of nodes) {
      pushCandidate(out, seen, node.writer);
      walk(node.replies);
    }
  };
  walk(view.comments);
  return out;
}

/**
 * Build a candidate pool from a loose list of writer-ish records — the flick
 * page has an author (with a tag) and a stream of commenters (pubkeys only),
 * not a `ThreadView`, so it feeds them straight in here.
 */
export function candidatesFrom(
  writers: readonly { pubkey: string; tag?: string | null; mark?: string }[],
): MentionCandidate[] {
  const out: MentionCandidate[] = [];
  const seen = new Set<string>();
  for (const w of writers) {
    pushCandidate(out, seen, { pubkey: w.pubkey, tag: w.tag ?? null, ...(w.mark ? { mark: w.mark } : {}) });
  }
  return out;
}

/**
 * The candidates whose handle matches what has been typed, best first.
 *
 * Case-insensitive. A prefix hit ("SH" → "SHAKE") ranks above a mere substring
 * hit ("HA" → "SHAKE"); a writer with a tag ranks above a mark-only writer; ties
 * break alphabetically so the order is stable. Capped at {@link MENTION_LIMIT}.
 * An empty query lists the whole pool (the dropdown that pops the instant you
 * type `@`).
 */
export function matchMentions(
  candidates: readonly MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  const scored: { candidate: MentionCandidate; prefix: number; tagRank: number; name: string }[] = [];
  for (const candidate of candidates) {
    const hasTag = Boolean(candidate.tag?.trim());
    const name = mentionHandle(candidate).toLowerCase();
    if (q && !name.includes(q)) continue;
    scored.push({
      candidate,
      prefix: q === '' || name.startsWith(q) ? 0 : 1,
      tagRank: hasTag ? 0 : 1,
      name,
    });
  }
  scored.sort(
    (a, b) => a.prefix - b.prefix || a.tagRank - b.tagRank || a.name.localeCompare(b.name),
  );
  return scored.slice(0, MENTION_LIMIT).map((s) => s.candidate);
}

/** Where the caret is sitting inside an `@token`, and what that token says. */
export interface ActiveMention {
  /** The characters after the `@`, up to the caret. May be empty. */
  query: string;
  /** Index of the `@` in the text — where a pick replaces from. */
  start: number;
}

const WORD = /\w/;
const SPACE = /\s/;

/**
 * The @token the caret is inside, or null when it is not inside one.
 *
 * A token is an `@` that starts a word (preceded by the start of the text or by
 * whitespace) followed by word characters up to the caret. `hey @sh|` is one;
 * `mail@sh|` (the `@` mid-word) is not, and neither is a caret sitting after a
 * space or punctuation. This is the whole trigger for showing the dropdown.
 */
export function activeMentionQuery(text: string, caret: number): ActiveMention | null {
  if (caret < 0 || caret > text.length) return null;
  let i = caret - 1;
  while (i >= 0 && WORD.test(text[i] ?? '')) i -= 1;
  if (i < 0 || text[i] !== '@') return null;
  const before = i - 1;
  if (before >= 0 && !SPACE.test(text[before] ?? '')) return null;
  return { query: text.slice(i + 1, caret), start: i };
}

/** The new draft (and where to put the caret) after a pick is dropped in. */
export interface AppliedMention {
  text: string;
  caret: number;
}

/**
 * Replace the `@partial` span (from `start` to the caret) with the candidate's
 * `@handle ` — trailing space included, so the writer can keep typing — and
 * report where the caret lands (just past that space).
 */
export function applyMention(
  text: string,
  start: number,
  caretEnd: number,
  candidate: MentionCandidate,
): AppliedMention {
  const insert = `@${mentionHandle(candidate)} `;
  return {
    text: text.slice(0, start) + insert + text.slice(caretEnd),
    caret: start + insert.length,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which of the candidates the finished draft actually names — the pubkeys that
 * should ride along as real `p` tags.
 *
 * Only a handle that literally appears as an @token in the text counts, so a
 * writer whose name was typed and then deleted, or who was never picked, is not
 * silently tagged. Matches either their `@tag` or their `@mark`, at a word
 * boundary (so `@sh` does not match inside `@shake`), and returns each pubkey
 * once.
 */
export function extractMentions(
  text: string,
  candidates: readonly MentionCandidate[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.pubkey)) continue;
    const handles = new Set<string>();
    if (candidate.tag?.trim()) handles.add(candidate.tag.trim());
    handles.add(candidate.mark);
    for (const handle of handles) {
      const pattern = new RegExp(`(?:^|\\s)@${escapeRegExp(handle)}(?![\\w])`, 'i');
      if (pattern.test(text)) {
        seen.add(candidate.pubkey);
        out.push(candidate.pubkey);
        break;
      }
    }
  }
  return out;
}
