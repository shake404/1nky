import { JARGON_BLOCKLIST, KINDS, REPORT_REASONS } from '@1nky/protocol';
import { describe, expect, it, vi } from 'vitest';

/**
 * "Flag it" — the reason table and what actually goes up.
 *
 * The wire vocabulary is fixed by the protocol and is never shown; the table
 * is the whole translation layer, so it is the thing worth pinning.
 */

const published: { template: { kind: number; tags: string[][]; content: string }; bits: number }[] = [];

vi.mock('./publish.js', () => ({
  publishTemplate: vi.fn(
    async (
      _secret: Uint8Array,
      _pubkey: string,
      template: { kind: number; tags: string[][]; content: string },
      bits: number,
    ) => {
      published.push({ template, bits });
      return { id: 'x'.repeat(64) };
    },
  ),
}));

const { FLAG_CHOICES, FLAG_NOTE_MAX, flagChoicesCoverEveryReason, flagIt, flagLabel } = await import('./flag.js');
const { POW_BITS } = await import('./config.js');

const me = { secret: new Uint8Array(32).fill(3), pubkey: 'f'.repeat(64) };
const writer = 'a'.repeat(64);
const post = 'b'.repeat(64);

function tagValue(index: number, name: string): string[] | undefined {
  return published[index]?.template.tags.find((t) => t[0] === name);
}

describe('the reason table', () => {
  it('labels every protocol reason exactly once, with no strays', () => {
    expect(flagChoicesCoverEveryReason()).toBe(true);
    expect(FLAG_CHOICES).toHaveLength(REPORT_REASONS.length);
    expect(new Set(FLAG_CHOICES.map((c) => c.reason)).size).toBe(FLAG_CHOICES.length);
  });

  it('maps each reason to the label a writer reads', () => {
    expect(flagLabel('illegal')).toBe('Straight-up illegal');
    expect(flagLabel('impersonation')).toBe('Biting / impersonation');
    expect(flagLabel('malware')).toBe('Sketchy file');
    expect(flagLabel('profanity')).toBe('Slurs');
    expect(flagLabel('other')).toBe('Something else');
  });

  it('falls back to the catch-all label for a reason it has never seen', () => {
    expect(flagLabel('something-new-on-the-wire')).toBe('Something else');
  });

  it('keeps every label clear of the jargon blocklist', () => {
    for (const choice of FLAG_CHOICES) {
      const lower = choice.label.toLowerCase();
      for (const banned of JARGON_BLOCKLIST) {
        expect(lower).not.toContain(banned);
      }
    }
  });
});

describe('flagIt', () => {
  it('puts the picked reason up against the post and the writer, at the cheap tier', async () => {
    published.length = 0;
    await flagIt(me, { pubkey: writer, eventId: post, kind: KINDS.FLICK }, 'spam');

    expect(published).toHaveLength(1);
    expect(published[0]?.template.kind).toBe(KINDS.REPORT);
    expect(published[0]?.bits).toBe(POW_BITS.reaction);
    // The wire reason rides on the `e` tag; the writer is named separately.
    expect(tagValue(0, 'e')).toEqual(['e', post, 'spam']);
    expect(tagValue(0, 'p')).toEqual(['p', writer]);
    expect(tagValue(0, 'k')).toEqual(['k', String(KINDS.FLICK)]);
  });

  it('carries a note when there is one and stays empty when there is not', async () => {
    published.length = 0;
    await flagIt(me, { pubkey: writer, eventId: post, kind: KINDS.VIDEO }, 'other', {
      note: '  it is the same flick as last week  ',
    });
    await flagIt(me, { pubkey: writer, eventId: post, kind: KINDS.VIDEO }, 'other');

    expect(published[0]?.template.content).toBe('it is the same flick as last week');
    expect(published[1]?.template.content).toBe('');
  });

  it('trims a rambling note down to one line', async () => {
    published.length = 0;
    await flagIt(me, { pubkey: writer, eventId: post, kind: KINDS.FLICK }, 'other', {
      note: 'x'.repeat(FLAG_NOTE_MAX + 50),
    });

    expect(published[0]?.template.content).toHaveLength(FLAG_NOTE_MAX);
  });
});
