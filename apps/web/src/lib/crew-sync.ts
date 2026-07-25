import {
  buildCrewKeyBackup,
  decryptCrewKey,
  encryptCrewKey,
  KINDS,
  parseCrewKeyBackup,
} from '@1nky/protocol';
import { POW_BITS } from './config.js';
import { hasCrewKey, saveCrewKey } from './crew-keys.js';
import { saveFoundedCrew } from './crews.js';
import type { Tag } from './identity.js';
import { publishTemplate } from './publish.js';
import { relay } from './relay.js';

/**
 * Crew-key sync — a founder's crew keys follow their tag to every device.
 *
 * Every crew secret this device holds is backed up ENCRYPTED TO THE WRITER'S
 * OWN TAG (nip44 self-encryption) and published to the relay as a kind-30078
 * app-data event keyed by the crew pubkey. Any device logged in as that tag
 * pulls the backups down, decrypts them, and repopulates its local keyring —
 * so a founder on a second device gets their founder panel back.
 *
 * ADDITIVE AND ISOLATED. Nothing here touches the single-identity `id:'me'`
 * store: it reads the tag (never writes it) and writes only the separate
 * `crewkeys` ring and the `founded-crews` pointer. The crew secret NEVER leaves
 * this device unencrypted — it rides only inside the ciphertext, which is
 * readable by no one but the owner (see `@1nky/protocol` crew-key.ts).
 */

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Back one held crew key up to the writer's own tag so their other devices can
 * pull it down. Encrypt the crew secret to `tag` (self-encryption), build the
 * kind-30078 backup, and publish it signed by the tag at the POST tier (a
 * kind-30078 is not a kind-0, so the newcomer gate does not apply; the retry in
 * `publishTemplate` covers a relay restart).
 *
 * BEST EFFORT — never throws into the caller. Founding / importing a crew still
 * works on this device even if the backup does not go up; the backup only
 * benefits the writer's OTHER devices.
 */
export async function backUpCrewKey(
  tag: Pick<Tag, 'secret' | 'pubkey'>,
  crew: { pubkey: string; secret: Uint8Array; name: string },
): Promise<void> {
  try {
    const ciphertext = encryptCrewKey(tag.secret, tag.pubkey, {
      secret: bytesToHex(crew.secret),
      name: crew.name,
      crewPubkey: crew.pubkey,
    });
    const template = buildCrewKeyBackup(tag.pubkey, crew.pubkey, ciphertext);
    await publishTemplate(tag.secret, tag.pubkey, template, POW_BITS.post);
  } catch {
    /* best effort — the crew still works on this device */
  }
}

/**
 * Pull the writer's own crew-key backups off the relay and repopulate this
 * device's keyring from them.
 *
 * Queries the relay for the writer's own kind-30078 events, keeps the ones
 * whose `d`-tag marks them a crew-key backup, decrypts each with the tag, and
 * for any crew key not already in the local ring saves BOTH the ring entry
 * (so the founder panel + crew edits work) and the founded-crews pointer (so
 * the Crews hub lists it). Returns the number of new crews added.
 *
 * Idempotent: a decrypt failure or a key already present is a silent skip, so
 * running it on every login (or Crews-hub load) never duplicates anything.
 */
export async function syncCrewKeys(tag: Pick<Tag, 'secret' | 'pubkey'>): Promise<number> {
  let events;
  try {
    events = await relay.query([{ kinds: [KINDS.APP_DATA], authors: [tag.pubkey], limit: 200 }]);
  } catch {
    return 0;
  }

  let added = 0;
  for (const event of events) {
    const parsed = parseCrewKeyBackup(event);
    if (!parsed) continue;
    const payload = decryptCrewKey(tag.secret, tag.pubkey, parsed.ciphertext);
    if (!payload) continue;
    try {
      if (await hasCrewKey(payload.crewPubkey)) continue;
      await saveCrewKey({ pubkey: payload.crewPubkey, secret: hexToBytes(payload.secret), name: payload.name });
      await saveFoundedCrew({ pubkey: payload.crewPubkey, name: payload.name, foundedByMe: true });
      added += 1;
    } catch {
      /* a single bad row must not abort the rest of the pull */
    }
  }
  return added;
}
