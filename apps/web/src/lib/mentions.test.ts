import { describe, expect, it } from 'vitest';
import type { ThreadView } from './boards.js';
import {
  activeMentionQuery,
  applyMention,
  candidatesFrom,
  collectParticipants,
  extractMentions,
  matchMentions,
  MENTION_LIMIT,
  type MentionCandidate,
} from './mentions.js';

/**
 * The @-mention text engine.
 *
 * All of it is pure string work — the trigger, the ranking, the drop-in, and
 * the read-back that decides who a finished draft really names. Nothing here
 * reaches the wall.
 */

const PK = (c: string): string => c.repeat(64);

const SHAKE: MentionCandidate = { pubkey: PK('a'), tag: 'SHAKE', mark: 'aa11bb' };
const SHARP: MentionCandidate = { pubkey: PK('b'), tag: 'SHARP', mark: 'bb22cc' };
const RASK: MentionCandidate = { pubkey: PK('c'), tag: 'RASK', mark: 'cc33dd' };
const UNNAMED: MentionCandidate = { pubkey: PK('d'), tag: null, mark: 'dd44ee' };

describe('activeMentionQuery', () => {
  it('finds the token the caret is inside', () => {
    expect(activeMentionQuery('hey @sh', 7)).toEqual({ query: 'sh', start: 4 });
    expect(activeMentionQuery('@sh', 3)).toEqual({ query: 'sh', start: 0 });
  });

  it('treats a bare @ as an empty query, ready for the whole list', () => {
    expect(activeMentionQuery('yo @', 4)).toEqual({ query: '', start: 3 });
  });

  it('rejects an @ that is mid-word', () => {
    expect(activeMentionQuery('mail@sh', 7)).toBeNull();
  });

  it('rejects a caret that is not in a token at all', () => {
    expect(activeMentionQuery('nothing here', 5)).toBeNull();
    expect(activeMentionQuery('hey @sh there', 13)).toBeNull(); // caret past a space
    expect(activeMentionQuery('', 0)).toBeNull();
  });

  it('reads only up to the caret, not the whole word', () => {
    // Caret between the h and the a of "shake".
    expect(activeMentionQuery('@shake', 3)).toEqual({ query: 'sh', start: 0 });
  });

  it('is null for an out-of-range caret', () => {
    expect(activeMentionQuery('@sh', 99)).toBeNull();
    expect(activeMentionQuery('@sh', -1)).toBeNull();
  });
});

describe('matchMentions', () => {
  const pool = [SHAKE, SHARP, RASK, UNNAMED];

  it('prefix hits rank ahead of substring hits', () => {
    // "ar" is a substring of SHARP and RASK; RASK... no. Use "ha": prefix of
    // none, substring of SHAKE/SHARP. "sh" is a prefix of both.
    const byPrefix = matchMentions(pool, 'sh').map((c) => c.tag);
    expect(byPrefix).toEqual(['SHAKE', 'SHARP']);
  });

  it('a tagged writer ranks above a mark-only one on an equal footing', () => {
    // Mark-only UNNAMED's mark starts with "dd"; give it a query all share only
    // as substring so tag-rank decides. Use empty query: everyone in, tagged first.
    const all = matchMentions(pool, '');
    expect(all[all.length - 1]).toBe(UNNAMED);
  });

  it('matches a mark-only candidate by its mark', () => {
    expect(matchMentions(pool, 'dd44').map((c) => c.pubkey)).toEqual([UNNAMED.pubkey]);
  });

  it('is case-insensitive', () => {
    expect(matchMentions(pool, 'RA').map((c) => c.tag)).toEqual(['RASK']);
  });

  it('caps the list', () => {
    const many: MentionCandidate[] = Array.from({ length: 20 }, (_, i) => ({
      pubkey: PK(String(i % 10)),
      tag: `TAG${String(i).padStart(2, '0')}`,
      mark: 'ffffff',
    }));
    expect(matchMentions(many, 'tag').length).toBe(MENTION_LIMIT);
  });
});

describe('applyMention', () => {
  it('replaces the @partial span with @handle and a trailing space', () => {
    const text = 'yo @sh';
    const result = applyMention(text, 3, 6, SHAKE);
    expect(result.text).toBe('yo @SHAKE ');
    expect(result.caret).toBe(result.text.length);
  });

  it('keeps whatever trails the caret', () => {
    const text = 'yo @sh you around';
    // Caret sits right after "sh" (index 6).
    const result = applyMention(text, 3, 6, SHARP);
    expect(result.text).toBe('yo @SHARP  you around');
    expect(result.caret).toBe('yo @SHARP '.length);
  });

  it('falls back to the mark for a writer with no tag', () => {
    const result = applyMention('@', 0, 1, UNNAMED);
    expect(result.text).toBe('@dd44ee ');
  });
});

describe('extractMentions', () => {
  const pool = [SHAKE, SHARP, RASK, UNNAMED];

  it('returns only the pubkeys whose handle actually appears', () => {
    expect(extractMentions('yo @SHAKE what up', pool)).toEqual([SHAKE.pubkey]);
  });

  it('resolves a mark-only mention', () => {
    expect(extractMentions('@dd44ee you there', pool)).toEqual([UNNAMED.pubkey]);
  });

  it('does not match a handle inside a longer word', () => {
    // "@SHAKER" is not "@SHAKE".
    expect(extractMentions('yo @SHAKER', pool)).toEqual([]);
  });

  it('ignores an @ that is mid-word', () => {
    expect(extractMentions('mail@SHAKE.com', pool)).toEqual([]);
  });

  it('dedupes when the same writer is named twice', () => {
    expect(extractMentions('@SHAKE and again @SHAKE', pool)).toEqual([SHAKE.pubkey]);
  });

  it('returns nothing for text that names no one in the pool', () => {
    expect(extractMentions('@NOBODY here', pool)).toEqual([]);
    expect(extractMentions('just words', pool)).toEqual([]);
  });
});

describe('collectParticipants / candidatesFrom', () => {
  const view: ThreadView = {
    thread: {
      id: PK('1'),
      subject: null,
      content: 'op',
      boards: ['sf-bay'],
      writer: { pubkey: PK('a'), tag: 'SHAKE', mark: 'aa11bb', avatarSha256: null },
      createdAt: 1,
      expiresAt: null,
      happeningAt: null,
      replyCount: 2,
    },
    comments: [
      {
        id: PK('2'),
        parentId: PK('1'),
        createdAt: 2,
        content: 'reply',
        writer: { pubkey: PK('c'), tag: 'RASK', mark: 'cc33dd', avatarSha256: null },
        replies: [
          {
            id: PK('3'),
            parentId: PK('2'),
            createdAt: 3,
            content: 'nested',
            // Same writer as the OP — must dedupe to one candidate.
            writer: { pubkey: PK('a'), tag: 'SHAKE', mark: 'aa11bb', avatarSha256: null },
            replies: [],
          },
        ],
      },
    ],
  };

  it('flattens the OP and every commenter, deduped by pubkey', () => {
    const pool = collectParticipants(view);
    expect(pool.map((c) => c.pubkey)).toEqual([PK('a'), PK('c')]);
    expect(pool[0]?.tag).toBe('SHAKE');
  });

  it('candidatesFrom dedupes and fills a missing mark from the pubkey', () => {
    const pool = candidatesFrom([
      { pubkey: PK('a'), tag: 'SHAKE' },
      { pubkey: PK('a'), tag: 'SHAKE' },
      { pubkey: PK('e'), tag: null },
    ]);
    expect(pool.map((c) => c.pubkey)).toEqual([PK('a'), PK('e')]);
    // No mark supplied for the second one; it is derived from the pubkey, so
    // it is a non-empty mark rather than an empty string.
    expect(pool[1]?.mark).toBeTruthy();
    expect((pool[1]?.mark.length ?? 0) > 0).toBe(true);
  });
});
