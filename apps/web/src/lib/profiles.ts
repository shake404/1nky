import { buildProfile, KINDS, type EventTemplate, type SignedEvent } from '@1nky/protocol';
import { relay } from './relay.js';
import type { Tag } from './identity.js';

/**
 * Kind-0 profile metadata — read and write.
 *
 * The `about` field is the bio a writer types about themselves; it is called
 * `bio` on this side because "about" means nothing to anyone, and serialised
 * as `about` on the wire because that is what every other client reads.
 */

export interface ProfileMeta {
  name: string;
  bio?: string;
  city?: string;
  avatarSha256?: string;
  /** Self-declared crew affiliations — a claim, not a verified roster. */
  crews?: string[];
}

/** Build a kind-0 template from the editable fields. Pure — no mining, no send. */
export function profileTemplate(
  tag: Pick<Tag, 'name'>,
  opts: { city?: string; bio?: string; avatarSha256?: string; crews?: readonly string[] } = {},
): EventTemplate {
  return buildProfile({
    tag: tag.name,
    ...(opts.city ? { city: opts.city } : {}),
    ...(opts.bio !== undefined ? { bio: opts.bio } : {}),
    ...(opts.avatarSha256 ? { avatarSha256: opts.avatarSha256 } : {}),
    ...(opts.crews ? { crews: opts.crews } : {}),
  });
}

function parseProfileContent(content: string): ProfileMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const name = typeof record['name'] === 'string' ? record['name'] : '';
  const meta: ProfileMeta = { name };
  if (typeof record['about'] === 'string') meta.bio = record['about'];
  if (typeof record['city'] === 'string') meta.city = record['city'];
  if (typeof record['avatar_sha256'] === 'string') meta.avatarSha256 = record['avatar_sha256'];
  if (Array.isArray(record['crews'])) {
    const crews = (record['crews'] as unknown[]).filter((c): c is string => typeof c === 'string');
    if (crews.length) meta.crews = crews;
  }
  return meta;
}

/** Read the latest kind-0 for a writer. Returns null when none / unreadable. */
export async function fetchProfile(pubkey: string): Promise<ProfileMeta | null> {
  const events = await relay.query([{ kinds: [KINDS.PROFILE], authors: [pubkey], limit: 1 }], 5000);
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) return null;
  return parseProfileContent(latest.content);
}

/** Same as {@link fetchProfile} but from an already-fetched event. */
export function profileFromEvent(event: SignedEvent): ProfileMeta | null {
  if (event.kind !== KINDS.PROFILE) return null;
  return parseProfileContent(event.content);
}
