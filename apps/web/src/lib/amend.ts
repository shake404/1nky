import { normalizeBoard, parseAmendment, type SignedEvent } from '@1nky/protocol';
import { canonicalWall } from './walls.js';

/**
 * "Add to this" — reading the additions back on the client.
 *
 * What went up is signed and cannot be changed, and every reply underneath it
 * points at that exact thing, so adding a wall you forgot is a second small
 * event that says "and this too" (see `amendPost`). Which means anything showing
 * a post has to do the same merge the wall does: take what the post said, add
 * what its author added later, and show the union.
 *
 * Two rules, and both matter:
 *
 *   * ONLY THE WRITER WHO PUT IT UP. An addition signed by anybody else is
 *     ignored outright — otherwise a stranger could put your flick on any wall
 *     they liked, or park it on one you would not want your name near.
 *   * ADD-ONLY. Walls accumulate; nothing here can take one away. So the merge
 *     is a union, which means it does not matter what order the additions turn
 *     up in — and they turn up in whatever order the wall hands them over.
 */

/** The walls a post is on, once the author's own later additions are folded in. */
export function amendedBoards(
  post: { id: string; pubkey: string; boards?: readonly string[] | undefined },
  amendments: readonly SignedEvent[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const slug = normalizeBoard(raw);
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    out.push(slug);
  };

  for (const board of post.boards ?? []) push(board);

  for (const event of amendments) {
    // The author check is the whole security model here, and it is cheap: the
    // addition has to be signed by the same tag that put the post up.
    if (event.pubkey.toLowerCase() !== post.pubkey.toLowerCase()) continue;
    const parsed = parseAmendment(event);
    if (!parsed || parsed.targetId !== post.id.toLowerCase()) continue;
    for (const board of parsed.boards) push(board);
  }

  return out;
}

/**
 * Turn what somebody typed into wall slugs: `"Oakland, 4th st"` -> two of them.
 *
 * Split on commas and newlines rather than on every space, because a wall is
 * often two words ("west oakland"), and slugified through the same
 * `normalizeBoard` the event tags use so what is typed is what is filed.
 * Deduped, empties dropped, and anything already on the post left out — adding a
 * wall it is already on is not an error, it is just nothing.
 */
export function parseWalls(input: string, already: readonly string[] = []): string[] {
  // Through the same canonicalizer the posting flow uses, so adding "frisco"
  // to a post lands on san-francisco instead of minting the duplicate wall
  // the gazetteer exists to prevent.
  const have = new Set(already.map((slug) => canonicalWall(normalizeBoard(slug))));
  const out: string[] = [];
  for (const part of input.split(/[,\n]+/)) {
    const slug = canonicalWall(normalizeBoard(part));
    if (!slug || have.has(slug)) continue;
    have.add(slug);
    out.push(slug);
  }
  return out;
}
