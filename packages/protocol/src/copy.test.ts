import { describe, expect, it } from 'vitest';
import { COPY, JARGON_BLOCKLIST } from './copy.js';
import {
  ALL_KINDS,
  isKnownKind,
  isRelayAcceptedKind,
  isWrapInternalKind,
  KINDS,
  RELAY_ACCEPTED_KINDS,
  WRAP_INTERNAL_KINDS,
} from './kinds.js';

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
      SEAL: 13,
      DM: 14,
      FLICK: 20,
      VIDEO: 22,
      GIFT_WRAP: 1059,
      COMMENT: 1111,
      AMENDMENT: 1113,
      REPORT: 1984,
      MUTE_LIST: 10000,
      APP_DATA: 30078,
      BLOSSOM_AUTH: 24242,
    });
  });

  it('exposes an allowlist for the relay write-policy', () => {
    expect(new Set(ALL_KINDS)).toEqual(
      new Set(Object.values(KINDS).filter((kind) => !WRAP_INTERNAL_KINDS.includes(kind))),
    );
    expect(isKnownKind(20)).toBe(true);
    expect(isKnownKind(9735)).toBe(false);
  });

  it('lets the gift wrap through but never the seal or the message itself', () => {
    // 1059 is the envelope: opaque, ephemerally signed, safe to store.
    expect(ALL_KINDS).toContain(KINDS.GIFT_WRAP);
    expect(RELAY_ACCEPTED_KINDS).toContain(KINDS.GIFT_WRAP);
    expect(isRelayAcceptedKind(KINDS.GIFT_WRAP)).toBe(true);

    // 13 and 14 only ever exist encrypted INSIDE that envelope. One arriving
    // at the relay is a private message in the clear.
    for (const list of [ALL_KINDS, RELAY_ACCEPTED_KINDS]) {
      expect(list).not.toContain(KINDS.SEAL);
      expect(list).not.toContain(KINDS.DM);
    }
    expect(isRelayAcceptedKind(KINDS.SEAL)).toBe(false);
    expect(isRelayAcceptedKind(KINDS.DM)).toBe(false);
  });

  it('keeps the Blossom upload credential off the relay', () => {
    // 24242 authorises an HTTP upload to the media service. It is a request
    // credential, not content, and nothing should ever publish one.
    expect(ALL_KINDS).toContain(KINDS.BLOSSOM_AUTH);
    expect(RELAY_ACCEPTED_KINDS).not.toContain(KINDS.BLOSSOM_AUTH);
    expect(isRelayAcceptedKind(KINDS.BLOSSOM_AUTH)).toBe(false);
  });

  it('still calls the wrap-internal kinds "known"', () => {
    // The DM helpers have to recognise a seal and a rumor after decryption.
    expect(isKnownKind(KINDS.SEAL)).toBe(true);
    expect(isKnownKind(KINDS.DM)).toBe(true);
    expect(WRAP_INTERNAL_KINDS).toEqual([13, 14]);
    expect(isWrapInternalKind(13)).toBe(true);
    expect(isWrapInternalKind(14)).toBe(true);
    expect(isWrapInternalKind(1059)).toBe(false);
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
