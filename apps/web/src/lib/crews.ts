import {
  buildCrewDefinition,
  buildProfile,
  fingerprint,
  generateSecretKey,
  getPublicKey,
  KINDS,
  type GrafType,
  type SignedEvent,
  type Surface,
} from '@1nky/protocol';
import { API_BASE } from './config.js';
import { fetchWriterFlicks, parseFeedResponse, type Flick } from './feed.js';
import { relay } from './relay.js';

/**
 * Crews — the read and create paths.
 *
 * Two trust levels, kept structurally distinct everywhere (design doc Part 4):
 *   - **Repping** is a self-declared claim on a writer's own kind-0
 *     (`content.crews`), shown on their profile. Anyone can claim anyone.
 *   - **Roster** is the crew-signed kind-30078 definition, the strong-trust
 *     membership list. Only someone holding the crew's blackbook can publish
 *     it — and "holding the crew's blackbook" is exactly the swap the create
 *     / post-as-crew flow below uses.
 *
 * The API already speaks both (`GET /crew/:pubkey` returns a `crew` header,
 * `members` roster, `repping` self-declared, and a unified `flicks` wall). We
 * prefer it; when it is unreachable we degrade to reading the relay directly
 * so the page still renders.
 */

export interface CrewHeader {
  pubkey: string;
  tag: string | null;
  mark: string;
  avatarSha256: string | null;
  founderPubkey: string | null;
  foundedAt: number | null;
  memberCount: number;
  verified: boolean;
  verifiedAt: number | null;
}

export interface CrewMember {
  pubkey: string;
  tag: string | null;
  mark: string;
  avatarSha256: string | null;
}

export interface CrewRepping {
  pubkey: string;
  tag: string | null;
  mark: string;
  avatarSha256: string | null;
}

export interface CrewPage {
  crew: CrewHeader;
  members: CrewMember[];
  repping: CrewRepping[];
  flicks: Flick[];
  nextCursor: string | null;
  degraded: boolean;
}

function emptyHeader(pubkey: string): CrewHeader {
  return {
    pubkey,
    tag: null,
    mark: fingerprint(pubkey),
    avatarSha256: null,
    founderPubkey: null,
    foundedAt: null,
    memberCount: 0,
    verified: false,
    verifiedAt: null,
  };
}

function parseCrewDefinition(event: SignedEvent): { name: string | null; founderPubkey: string | null; foundedAt: number | null; members: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return { name: null, founderPubkey: null, foundedAt: null, members: [] };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { name: null, founderPubkey: null, foundedAt: null, members: [] };
  }
  const record = parsed as Record<string, unknown>;
  const members = Array.isArray(record['members'])
    ? (record['members'] as unknown[]).filter((m): m is string => typeof m === 'string')
    : [];
  const rosterFromTags = event.tags.filter((t) => t[0] === 'p' && typeof t[1] === 'string').map((t) => t[1] as string);
  const merged = Array.from(new Set([...rosterFromTags, ...members]));
  return {
    name: typeof record['name'] === 'string' ? record['name'] : null,
    founderPubkey: typeof record['founderPubkey'] === 'string' ? record['founderPubkey'] : null,
    foundedAt: typeof record['foundedAt'] === 'number' ? record['foundedAt'] : null,
    members: merged,
  };
}

function crewNameFromProfile(event: SignedEvent): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const name = (parsed as Record<string, unknown>)['name'];
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/**
 * `GET /crew/:pubkey`, with a relay-direct degrade.
 *
 * The degrade reads the crew's own kind-0 (name) and kind-30078 definition
 * (roster, founder, foundedAt) straight from the wall. Verification badges
 * are mod-issued and live behind the API, so the degrade cannot surface them —
 * `verified` is simply false, which is the safe default (never show a checkmark
 * a mod has not actually issued).
 */
export async function fetchCrew(pubkey: string, cursor: string | null = null): Promise<CrewPage> {
  const url = new URL(`${API_BASE}/crew/${pubkey}`);
  if (cursor) url.searchParams.set('cursor', cursor);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (response.ok) {
      const body = (await response.json()) as Record<string, unknown>;
      return shapeCrewResponse(body, pubkey);
    }
    if (response.status !== 404) throw new Error('degrade');
  } catch {
    /* fall through to relay */
  }
  return relayCrew(pubkey);
}

function shapeCrewResponse(body: Record<string, unknown>, pubkey: string): CrewPage {
  const crewRaw = body['crew'];
  const crewRecord = (typeof crewRaw === 'object' && crewRaw !== null ? crewRaw : {}) as Record<string, unknown>;
  const crew: CrewHeader = {
    pubkey,
    tag: typeof crewRecord['tag'] === 'string' && crewRecord['tag'] ? crewRecord['tag'] : null,
    mark: typeof crewRecord['mark'] === 'string' && crewRecord['mark'] ? crewRecord['mark'] : fingerprint(pubkey),
    avatarSha256: typeof crewRecord['avatarSha256'] === 'string' ? crewRecord['avatarSha256'] : null,
    founderPubkey: typeof crewRecord['founderPubkey'] === 'string' ? crewRecord['founderPubkey'] : null,
    foundedAt: typeof crewRecord['foundedAt'] === 'number' ? crewRecord['foundedAt'] : null,
    memberCount: typeof crewRecord['memberCount'] === 'number' ? crewRecord['memberCount'] : 0,
    verified: crewRecord['verified'] === true,
    verifiedAt: typeof crewRecord['verifiedAt'] === 'number' ? crewRecord['verifiedAt'] : null,
  };

  const members = Array.isArray(body['members'])
    ? (body['members'] as unknown[]).filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null).map((m) => ({
        pubkey: typeof m['pubkey'] === 'string' ? m['pubkey'] : '',
        tag: typeof m['tag'] === 'string' && m['tag'] ? m['tag'] : null,
        mark: typeof m['mark'] === 'string' && m['mark'] ? m['mark'] : fingerprint(typeof m['pubkey'] === 'string' ? m['pubkey'] : ''),
        avatarSha256: typeof m['avatarSha256'] === 'string' ? m['avatarSha256'] : null,
      }))
    : [];

  const repping = Array.isArray(body['repping'])
    ? (body['repping'] as unknown[]).filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null).map((m) => ({
        pubkey: typeof m['pubkey'] === 'string' ? m['pubkey'] : '',
        tag: typeof m['tag'] === 'string' && m['tag'] ? m['tag'] : null,
        mark: typeof m['mark'] === 'string' && m['mark'] ? m['mark'] : fingerprint(typeof m['pubkey'] === 'string' ? m['pubkey'] : ''),
        avatarSha256: typeof m['avatarSha256'] === 'string' ? m['avatarSha256'] : null,
      }))
    : [];

  const flicksRaw = body['flicks'];
  // Reuse feed.ts' row shaping so video vs flick is picked consistently.
  const flicks = Array.isArray(flicksRaw) ? parseFeedResponse({ flicks: flicksRaw }).flicks : [];
  const rawCursor = body['nextCursor'];
  return {
    crew,
    members,
    repping,
    flicks,
    nextCursor: typeof rawCursor === 'string' && rawCursor ? rawCursor : null,
    degraded: false,
  };
}

async function relayCrew(pubkey: string): Promise<CrewPage> {
  const events = await relay.query(
    [
      { kinds: [KINDS.PROFILE, KINDS.APP_DATA], authors: [pubkey], limit: 20 },
    ],
    5000,
  );

  const profiles = events.filter((e) => e.kind === KINDS.PROFILE).sort((a, b) => b.created_at - a.created_at);
  const definitions = events
    .filter((e) => e.kind === KINDS.APP_DATA && e.tags.some((t) => t[0] === 'd' && t[1] === 'crew'))
    .sort((a, b) => b.created_at - a.created_at);
  const definition = definitions[0];
  const def = definition ? parseCrewDefinition(definition) : { name: null, founderPubkey: null, foundedAt: null, members: [] };

  const profileName = profiles[0] ? crewNameFromProfile(profiles[0]) : null;
  const tagName = def.name ?? profileName;

  const flicks = await fetchWriterFlicks(pubkey);

  return {
    crew: {
      pubkey,
      tag: tagName,
      mark: fingerprint(pubkey),
      avatarSha256: null,
      founderPubkey: def.founderPubkey,
      foundedAt: def.foundedAt,
      memberCount: def.members.length,
      verified: false,
      verifiedAt: null,
    },
    members: def.members.map((pk) => ({ pubkey: pk, tag: null, mark: fingerprint(pk), avatarSha256: null })),
    repping: [],
    flicks,
    nextCursor: null,
    degraded: true,
  };
}

// ---------------------------------------------------------------------------
// Writer crews — the repping claim on a writer's own profile.
// ---------------------------------------------------------------------------

/**
 * The crew pubkeys/handles a writer has self-declared on their kind-0.
 *
 * Prefers the API (`GET /writer/:pubkey` returns `writer.crews`); degrades to
 * reading the kind-0 `content.crews` straight off the relay.
 */
export async function fetchWriterCrews(pubkey: string): Promise<string[]> {
  try {
    const response = await fetch(`${API_BASE}/writer/${pubkey}`, { headers: { Accept: 'application/json' } });
    if (response.ok) {
      const body = (await response.json()) as Record<string, unknown>;
      const writerRaw = body['writer'];
      const writer = (typeof writerRaw === 'object' && writerRaw !== null ? writerRaw : {}) as Record<string, unknown>;
      if (Array.isArray(writer['crews'])) {
        return (writer['crews'] as unknown[]).filter((c): c is string => typeof c === 'string');
      }
    }
  } catch {
    /* fall through */
  }
  const events = await relay.query([{ kinds: [KINDS.PROFILE], authors: [pubkey], limit: 1 }], 5000);
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) return [];
  try {
    const parsed = JSON.parse(latest.content) as Record<string, unknown>;
    if (Array.isArray(parsed['crews'])) {
      return (parsed['crews'] as unknown[]).filter((c): c is string => typeof c === 'string');
    }
  } catch {
    return [];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Create a crew.
// ---------------------------------------------------------------------------

export interface CreateCrewResult {
  /** The crew's own 32-byte secret. THE blackbook — hand it to members. */
  secret: Uint8Array;
  /** The crew's pubkey. */
  pubkey: string;
  /** The crew's mark (fingerprint of the pubkey). */
  mark: string;
  name: string;
}

/**
 * Create a crew: mint a fresh keypair, then publish its kind-0 profile and its
 * kind-30078 definition, both signed by the crew's own key.
 *
 * Returns the crew secret so the founder can immediately export the crew
 * blackbook (reusing the existing NIP-49 export + QR) and hand it to members —
 * that blackbook is exactly how "post as crew" works later (see Shell's
 * blackbook-swap note), so this is the one time the raw secret is surfaced.
 */
export async function createCrew(
  name: string,
  founderPubkey: string,
  publish: (secret: Uint8Array, pubkey: string, kind: 'profile' | 'definition') => Promise<void>,
): Promise<CreateCrewResult> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Pick a crew name first.');

  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const mark = fingerprint(pubkey);

  await publish(secret, pubkey, 'profile');
  await publish(secret, pubkey, 'definition');

  return { secret, pubkey, mark, name: trimmed };
}

/** Build the two templates a freshly-minted crew publishes. Exposed for tests. */
export function crewTemplates(name: string, founderPubkey: string, mark: string): {
  profile: ReturnType<typeof buildProfile>;
  definition: ReturnType<typeof buildCrewDefinition>;
} {
  return {
    profile: buildProfile({ tag: name }),
    definition: buildCrewDefinition({ name, mark, members: [founderPubkey], founderPubkey }),
  };
}

// Re-export the facet vocabularies for the post-flow picker so callers import
// everything crew/explore-related from one place if they want to.
export type { GrafType, Surface };