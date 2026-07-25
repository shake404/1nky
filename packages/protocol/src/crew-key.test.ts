import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import {
  buildCrewKeyBackup,
  CREW_KEY_BACKUP_DTAG_PREFIX,
  decryptCrewKey,
  encryptCrewKey,
  parseCrewKeyBackup,
  type CrewKeyPayload,
} from './crew-key.js';
import { KINDS } from './kinds.js';

const owner = generateSecretKey();
const ownerPub = getPublicKey(owner);
const stranger = generateSecretKey();
const strangerPub = getPublicKey(stranger);

const crewSecret = generateSecretKey();
const crewPub = getPublicKey(crewSecret);

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

const payload: CrewKeyPayload = { secret: hex(crewSecret), name: 'FASE', crewPubkey: crewPub };

describe('encryptCrewKey / decryptCrewKey', () => {
  it('round-trips a payload the owner encrypted to themselves', () => {
    const ciphertext = encryptCrewKey(owner, ownerPub, payload);
    expect(ciphertext).not.toContain(payload.secret);
    expect(decryptCrewKey(owner, ownerPub, ciphertext)).toEqual(payload);
  });

  it('cannot be decrypted by a different key', () => {
    const ciphertext = encryptCrewKey(owner, ownerPub, payload);
    // The stranger tries with their own conversation key (to the owner's pub).
    expect(decryptCrewKey(stranger, ownerPub, ciphertext)).toBeNull();
    // Even the owner keyed to the wrong counterparty fails — the key differs.
    expect(decryptCrewKey(owner, strangerPub, ciphertext)).toBeNull();
  });

  it('returns null on junk rather than throwing', () => {
    expect(decryptCrewKey(owner, ownerPub, 'not-a-ciphertext')).toBeNull();
    expect(decryptCrewKey(owner, ownerPub, '')).toBeNull();
    expect(decryptCrewKey(owner, ownerPub, 123 as unknown as string)).toBeNull();
    // Valid nip44 wrapping a non-payload JSON also falls through as null.
    const notPayload = encryptCrewKey(owner, ownerPub, { foo: 'bar' } as unknown as CrewKeyPayload);
    expect(decryptCrewKey(owner, ownerPub, notPayload)).toBeNull();
  });
});

describe('buildCrewKeyBackup', () => {
  it('is a kind-30078 with the crewkey: d-tag and the ciphertext as content', () => {
    const ciphertext = encryptCrewKey(owner, ownerPub, payload);
    const template = buildCrewKeyBackup(ownerPub, crewPub, ciphertext);

    expect(template.kind).toBe(KINDS.APP_DATA);
    expect(template.content).toBe(ciphertext);
    const d = template.tags.find((t) => t[0] === 'd');
    expect(d).toEqual(['d', `${CREW_KEY_BACKUP_DTAG_PREFIX}${crewPub}`]);
    // The crew secret hex must never appear in the wire event's content.
    expect(template.content).not.toContain(payload.secret);
  });

  it('rejects a non-hex owner or crew pubkey and an empty ciphertext', () => {
    expect(() => buildCrewKeyBackup('nope', crewPub, 'ct')).toThrow();
    expect(() => buildCrewKeyBackup(ownerPub, 'nope', 'ct')).toThrow();
    expect(() => buildCrewKeyBackup(ownerPub, crewPub, '')).toThrow();
  });
});

describe('parseCrewKeyBackup', () => {
  it('reads back a signed backup event', () => {
    const ciphertext = encryptCrewKey(owner, ownerPub, payload);
    const template = buildCrewKeyBackup(ownerPub, crewPub, ciphertext);
    const signed = finalizeEvent(template, owner);

    const parsed = parseCrewKeyBackup(signed);
    expect(parsed).toEqual({ crewPubkey: crewPub, ciphertext });
    // And it decrypts end-to-end from the parsed ciphertext.
    expect(decryptCrewKey(owner, ownerPub, parsed!.ciphertext)).toEqual(payload);
  });

  it('returns null for junk', () => {
    expect(parseCrewKeyBackup({ kind: KINDS.NOTE, tags: [['d', `crewkey:${crewPub}`]], content: 'x' })).toBeNull();
    expect(parseCrewKeyBackup({ kind: KINDS.APP_DATA, tags: [['d', 'ban:' + crewPub]], content: 'x' })).toBeNull();
    expect(parseCrewKeyBackup({ kind: KINDS.APP_DATA, tags: [['d', 'crewkey:nope']], content: 'x' })).toBeNull();
    expect(parseCrewKeyBackup({ kind: KINDS.APP_DATA, tags: [['d', `crewkey:${crewPub}`]], content: '' })).toBeNull();
    expect(parseCrewKeyBackup({ kind: KINDS.APP_DATA, tags: [], content: 'x' })).toBeNull();
  });
});
