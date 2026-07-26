import { buildAmendment, finalizeEvent, generateSecretKey, getPublicKey, KINDS } from '@1nky/protocol';
import { describe, expect, it } from 'vitest';
import { amendedBoards, parseWalls } from './amend.js';

/**
 * Reading "Add to this" back.
 *
 * Two things are load-bearing and neither is obvious: an addition from anybody
 * other than the writer who put the post up counts for nothing, and the merge is
 * a union — so the order the wall hands things over in cannot change what is
 * shown.
 */

const OWNER_SK = generateSecretKey();
const OWNER = getPublicKey(OWNER_SK);
const STRANGER_SK = generateSecretKey();

const FLICK = { id: 'a'.repeat(64), pubkey: OWNER, boards: ['sf'] };

function addition(
  boards: readonly string[],
  secret = OWNER_SK,
  targetId = FLICK.id,
  createdAt = 1_700_000_000,
) {
  return finalizeEvent(
    buildAmendment(
      { id: targetId, pubkey: OWNER, kind: KINDS.FLICK },
      { boards, createdAt },
    ),
    secret,
  );
}

describe('amendedBoards', () => {
  it('is just the post walls when nothing was added', () => {
    expect(amendedBoards(FLICK, [])).toEqual(['sf']);
    expect(amendedBoards({ id: FLICK.id, pubkey: OWNER }, [])).toEqual([]);
  });

  it('folds in the walls the writer added later', () => {
    expect(amendedBoards(FLICK, [addition(['Oakland'])])).toEqual(['sf', 'oakland']);
  });

  it('ignores an addition signed by anybody else', () => {
    // The whole security model: otherwise a stranger parks your flick anywhere.
    expect(amendedBoards(FLICK, [addition(['tagfarm'], STRANGER_SK)])).toEqual(['sf']);
  });

  it('ignores an addition aimed at a different post', () => {
    expect(amendedBoards(FLICK, [addition(['oakland'], OWNER_SK, 'b'.repeat(64))])).toEqual(['sf']);
  });

  it('is a union: repeats collapse and order does not matter', () => {
    const first = addition(['sf', 'oakland'], OWNER_SK, FLICK.id, 1_700_000_000);
    const second = addition(['trains'], OWNER_SK, FLICK.id, 1_700_000_100);

    expect(amendedBoards(FLICK, [first, second])).toEqual(['sf', 'oakland', 'trains']);
    // Newest first is what a wall actually hands back.
    expect(amendedBoards(FLICK, [second, first])).toEqual(['sf', 'trains', 'oakland']);
    // And the same set either way, which is the property that matters.
    expect([...amendedBoards(FLICK, [second, first])].sort()).toEqual(
      [...amendedBoards(FLICK, [first, second])].sort(),
    );
  });

  it('steps over anything that is not a readable addition', () => {
    const junk = finalizeEvent(
      { kind: KINDS.AMENDMENT, created_at: 1, tags: [['e', 'nope']], content: '' },
      OWNER_SK,
    );
    const comment = finalizeEvent(
      { kind: KINDS.COMMENT, created_at: 1, tags: [['e', FLICK.id]], content: 'hi' },
      OWNER_SK,
    );
    expect(amendedBoards(FLICK, [junk, comment, addition(['oakland'])])).toEqual(['sf', 'oakland']);
  });
});

describe('parseWalls', () => {
  it('splits on commas, not on every space, so a two-word wall survives', () => {
    expect(parseWalls('west oakland, trains')).toEqual(['west-oakland', 'trains']);
  });

  it('canonicalizes through the same alias map the posting flow uses', () => {
    // Adding "frisco" to a post must not mint a wall the picker prevents.
    expect(parseWalls('frisco')).toEqual(['san-francisco']);
    expect(parseWalls('  #SF Bay  ')).toEqual(['san-francisco']);
  });

  it('drops empties and repeats — including two nicknames for the same wall', () => {
    expect(parseWalls('sf,,  , frisco , SF')).toEqual(['san-francisco']);
    expect(parseWalls('')).toEqual([]);
    expect(parseWalls('###')).toEqual([]);
  });

  it('leaves out a wall the post is already on — even via a different nickname', () => {
    expect(parseWalls('SF, oakland', ['san-francisco'])).toEqual(['oakland']);
    expect(parseWalls('frisco', ['sf'])).toEqual([]);
  });
});
