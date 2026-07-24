import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';
import {
  blackbookFileContents,
  blackbookFilename,
  decryptBlackbook,
  encryptBlackbook,
  isBlackbookPayload,
  parseBlackbookFile,
} from './blackbook.js';
import { COPY } from './copy.js';

// Low scrypt cost so the suite stays fast; production uses the NIP-49
// default of 2^16 and the exercise below covers it once.
const FAST = { logn: 8 };

describe('encryptBlackbook / decryptBlackbook', () => {
  it('round-trips a secret key', () => {
    const sk = generateSecretKey();
    const payload = encryptBlackbook(sk, 'nine dead pigeons', FAST);
    expect(payload.startsWith('ncryptsec1')).toBe(true);
    expect(isBlackbookPayload(payload)).toBe(true);

    const restored = decryptBlackbook(payload, 'nine dead pigeons');
    expect(Array.from(restored)).toEqual(Array.from(sk));
    expect(getPublicKey(restored)).toBe(getPublicKey(sk));
  });

  it(
    'round-trips at the production work factor',
    () => {
      const sk = generateSecretKey();
      const payload = encryptBlackbook(sk, 'correct horse');
      expect(Array.from(decryptBlackbook(payload, 'correct horse'))).toEqual(Array.from(sk));
    },
    30_000,
  );

  it('produces a different payload every time (fresh salt and nonce)', () => {
    const sk = generateSecretKey();
    expect(encryptBlackbook(sk, 'same pass', FAST)).not.toBe(
      encryptBlackbook(sk, 'same pass', FAST),
    );
  });

  it('normalises the passphrase (NFKC) so accents round-trip across keyboards', () => {
    const sk = generateSecretKey();
    // Same word, two Unicode spellings: e + combining acute vs a single
    // precomposed codepoint. A phone keyboard and a desktop keyboard can emit
    // different ones; NIP-49 NFKC-normalises so both open the same blackbook.
    const decomposed = 'cafe' + String.fromCharCode(0x0301);
    const precomposed = 'caf' + String.fromCharCode(0x00e9);
    expect(decomposed).not.toBe(precomposed);
    const payload = encryptBlackbook(sk, decomposed, FAST);
    expect(Array.from(decryptBlackbook(payload, precomposed))).toEqual(Array.from(sk));
  });

  it('fails on the wrong passphrase', () => {
    const payload = encryptBlackbook(generateSecretKey(), 'right', FAST);
    expect(() => decryptBlackbook(payload, 'wrong')).toThrow();
  });

  it('rejects junk input', () => {
    expect(() => encryptBlackbook(new Uint8Array(31), 'x')).toThrow(TypeError);
    expect(() => encryptBlackbook(generateSecretKey(), '')).toThrow(TypeError);
    expect(() => decryptBlackbook('hello', 'x')).toThrow(TypeError);
    expect(() => decryptBlackbook(nsecEncode(generateSecretKey()), 'x')).toThrow(TypeError);
    expect(isBlackbookPayload('ncryptsec1')).toBe(false);
  });
});

describe('blackbookFileContents', () => {
  const sk = generateSecretKey();
  const payload = encryptBlackbook(sk, 'pass', FAST);
  const file = blackbookFileContents('SEKT', payload);

  it('leads with the warning copy, verbatim', () => {
    expect(file).toContain(
      'Lose your blackbook, lose your tag. Nobody can recover it. Not even us. Especially not us.',
    );
    expect(file).toContain(COPY.blackbook.warning);
  });

  it('names the tag and embeds the payload', () => {
    expect(file).toContain('TAG: SEKT');
    expect(file).toContain(payload);
    expect(file).toContain('----- BEGIN BLACKBOOK -----');
    expect(file).toContain('----- END BLACKBOOK -----');
  });

  it('uses no jargon', () => {
    const lower = file.toLowerCase();
    for (const word of ['nsec', 'npub', 'nostr', 'private key', 'relay', 'crypto', 'keypair']) {
      expect(lower).not.toContain(word);
    }
  });

  it('round-trips through parseBlackbookFile', () => {
    expect(parseBlackbookFile(file)).toBe(payload);
    expect(Array.from(decryptBlackbook(parseBlackbookFile(file), 'pass'))).toEqual(Array.from(sk));
  });

  it('parses a bare payload too (user pasted just the block)', () => {
    expect(parseBlackbookFile(`  ${payload}\n`)).toBe(payload);
    expect(() => parseBlackbookFile('my grocery list')).toThrow(TypeError);
  });
});

describe('blackbookFilename', () => {
  it.each([
    ['SEKT', '1nky-blackbook-sekt.txt'],
    ['Two Words', '1nky-blackbook-two-words.txt'],
    ['!!!', '1nky-blackbook-tag.txt'],
  ])('%s -> %s', (tag, expected) => {
    expect(blackbookFilename(tag)).toBe(expected);
  });
});
