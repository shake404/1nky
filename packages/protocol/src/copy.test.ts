import { describe, expect, it } from 'vitest';
import { COPY, JARGON_BLOCKLIST } from './copy.js';
import { ALL_KINDS, isKnownKind, KINDS } from './kinds.js';

function strings(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  }
  return [];
}

describe('KINDS', () => {
  it('pins the wire numbers', () => {
    expect(KINDS).toEqual({
      PROFILE: 0,
      NOTE: 1,
      DELETE: 5,
      FLICK: 20,
      COMMENT: 1111,
      REPORT: 1984,
      MUTE_LIST: 10000,
      APP_DATA: 30078,
      BLOSSOM_AUTH: 24242,
    });
  });

  it('exposes an allowlist for the relay write-policy', () => {
    expect(new Set(ALL_KINDS)).toEqual(new Set(Object.values(KINDS)));
    expect(isKnownKind(20)).toBe(true);
    expect(isKnownKind(9735)).toBe(false);
  });
});

describe('COPY', () => {
  it('carries the graffiti copy deck verbatim', () => {
    expect(COPY.buff.label).toBe('Buff this');
    expect(COPY.buff.past).toBe('buffed');
    expect(COPY.blackbook.label).toBe('blackbook');
    expect(COPY.blackbook.warning).toBe(
      'Lose your blackbook, lose your tag. Nobody can recover it. Not even us. Especially not us.',
    );
    expect(COPY.flick.label).toBe('flick');
    expect(COPY.hangItUp.label).toBe('Hang it up');
    expect(COPY.mark.label).toBe('mark');
    expect(COPY.mark.hint).toBe('same name, different mark = different writer');
    expect(COPY.spraying.label).toBe('spraying...');
    expect(COPY.flagIt.label).toBe('Flag it');
    expect(COPY.ignoreWriter.label).toBe('Ignore this writer');
    expect(COPY.tag.label).toBe('tag');
    expect(COPY.putOn.label).toBe('getting put on');
    expect(COPY.beef.label).toBe('beef');
    expect(COPY.crew.label).toBe('crew');
  });

  it('contains no Nostr jargon anywhere (hard rule 3)', () => {
    const offenders: string[] = [];
    for (const [path, text] of strings(COPY)) {
      for (const word of JARGON_BLOCKLIST) {
        if (text.toLowerCase().includes(word)) offenders.push(`${path}: "${text}" contains "${word}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never mentions mining in the proof-of-work copy', () => {
    for (const [, text] of strings(COPY.spraying)) {
      expect(text.toLowerCase()).not.toContain('min');
    }
  });
});
