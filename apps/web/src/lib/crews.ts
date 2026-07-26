import {
  buildCrewDefinition,
  buildProfile,
  CREW_DEFINITION_DTAG,
  fingerprint,
  generateSecretKey,
  getPublicKey,
  KINDS,
  PROFILE_BIO_MAX,
  type GrafType,
  type SignedEvent,
  type Surface,
} from '@1nky/protocol';
import { API_BASE, POW_BITS } from './config.js';
import { fetchWriterFlicks, parseFeedResponse, type Flick } from './feed.js';
import { getPref, setPref } from './db.js';
import type { Tag } from './identity.js';
import { resolveLookupInput } from './lookup.js';
import { fetchProfile } from './profiles.js';
import { publishProfile, publishTemplate, type PublishOptions } from './publish.js';
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
  /** The crew's bio / description, from the crew's own kind-0 `about`. Null when unset. */
  bio: string | null;
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
    bio: null,
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

/** Read the crew's bio (`about`) straight off its own kind-0 event. */
function crewBioFromProfile(event: SignedEvent): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const about = (parsed as Record<string, unknown>)['about'];
  return typeof about === 'string' && about.trim() ? about.trim() : null;
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
    // The API surfaces the crew's bio under either `bio` (our field name) or
    // the ecosystem `about` — accept either so the page renders as soon as
    // the indexer exposes one.
    bio:
      typeof crewRecord['bio'] === 'string' && crewRecord['bio'].trim()
        ? crewRecord['bio'].trim()
        : typeof crewRecord['about'] === 'string' && crewRecord['about'].trim()
          ? (crewRecord['about'] as string).trim()
          : null,
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
  const profileBio = profiles[0] ? crewBioFromProfile(profiles[0]) : null;
  const tagName = def.name ?? profileName;

  const flicks = await fetchWriterFlicks(pubkey);

  // Resolved roster: enrich each member's bare pubkey with their tag name when
  // their kind-0 is reachable on the wall. A miss reads as "unnamed" upstream,
  // never as the raw hex — the mark already disambiguates them.
  const members: CrewMember[] = def.members.map((pk) => ({
    pubkey: pk,
    tag: null,
    mark: fingerprint(pk),
    avatarSha256: null,
  }));
  await Promise.allSettled(
    members.map(async (m) => {
      const meta = await fetchProfile(m.pubkey);
      if (meta?.name?.trim()) m.tag = meta.name.trim();
    }),
  );

  return {
    crew: {
      pubkey,
      tag: tagName,
      mark: fingerprint(pubkey),
      avatarSha256: null,
      bio: profileBio,
      founderPubkey: def.founderPubkey,
      foundedAt: def.foundedAt,
      memberCount: def.members.length,
      verified: false,
      verifiedAt: null,
    },
    members,
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
export function crewTemplates(
  name: string,
  founderPubkey: string,
  mark: string,
  options: { bio?: string } = {},
): {
  profile: ReturnType<typeof buildProfile>;
  definition: ReturnType<typeof buildCrewDefinition>;
} {
  return {
    profile: buildProfile({
      tag: name,
      ...(options.bio !== undefined ? { bio: options.bio } : {}),
    }),
    definition: buildCrewDefinition({ name, mark, members: [founderPubkey], founderPubkey }),
  };
}

// ---------------------------------------------------------------------------
// Founded crews — the local, offline-first record of crews this device minted.
// ---------------------------------------------------------------------------

/**
 * A locally-saved pointer to a crew this device founded.
 *
 * The crew SECRET is never stored here (or anywhere on this device) — post-as
 * -crew stays the blackbook-swap flow. This is just enough to make the Crews
 * hub instant and reachable offline: the pubkey, the name, and the fact that
 * this device is the founder.
 */
export interface FoundedCrew {
  pubkey: string;
  name: string;
  foundedByMe: true;
}

const FOUNDED_CREWS_KEY = 'founded-crews';

export async function loadFoundedCrews(): Promise<FoundedCrew[]> {
  return getPref<FoundedCrew[]>(FOUNDED_CREWS_KEY, []);
}

export async function saveFoundedCrew(crew: FoundedCrew): Promise<void> {
  const current = await loadFoundedCrews();
  if (current.some((c) => c.pubkey === crew.pubkey)) return;
  await setPref(FOUNDED_CREWS_KEY, [...current, crew]);
}

export async function forgetFoundedCrews(): Promise<void> {
  await setPref(FOUNDED_CREWS_KEY, []);
}

// ---------------------------------------------------------------------------
// Link a freshly-founded crew onto the founder's kind-0 (`content.crews`).
// ---------------------------------------------------------------------------

/**
 * Add a crew pubkey to the founder's own profile crews list and re-publish the
 * kind-0 so the crew is portable and shows up on the founder's page.
 *
 * Used by the CreateCrew success path: AFTER the crew blackbook is exported, we
 * link (export first, then link — but do link). The founder is already seen so
 * this mines at the POST tier. `fetchWriterCrews` failing is tolerated (treated
 * as "no existing crews") so a flaky read never blocks the link.
 */
export async function linkCrewToFounder(
  founder: Pick<Tag, 'secret' | 'pubkey' | 'name'>,
  crewPubkey: string,
): Promise<void> {
  const existing = await fetchWriterCrews(founder.pubkey).catch(() => [] as string[]);
  // Already linked — nothing to do (saves a needless round of work).
  if (existing.includes(crewPubkey)) return;
  const meta = await fetchProfile(founder.pubkey).catch(() => null);
  await publishProfile(founder, {
    first: false,
    ...(meta?.bio !== undefined ? { bio: meta.bio } : {}),
    ...(meta?.city ? { city: meta.city } : {}),
    ...(meta?.avatarSha256 ? { avatarSha256: meta.avatarSha256 } : {}),
    crews: [...existing, crewPubkey],
  });
}

// Re-export the facet vocabularies for the post-flow picker so callers import
// everything crew/explore-related from one place if they want to.
export type { GrafType, Surface };

// ---------------------------------------------------------------------------
// Founder roster management — signed by the CREW key, never the founder's tag.
// ---------------------------------------------------------------------------

/**
 * Pull a writer's (or crew's) id out of a "put someone on" input.
 *
 * A thin re-export of the shared parser in `lookup.ts` — kept under its
 * original name because both the crew founder panel and the account-restore
 * locked-copy handle already call it. See {@link resolveLookupInput} for
 * what it accepts and why a mark is deliberately rejected.
 *
 * Returns the 64-char lowercase hex id, or `null`.
 */
export const resolveWriterInput = resolveLookupInput;

/**
 * Re-publish the crew's kind-30078 definition with an updated roster, signed by
 * the crew's *own* key from the founder's keyring (never the founder's tag).
 *
 * Builds the template, grinds the post-tier PoW, and publishes. Pass the full
 * roster you want to end up with — `{ members }` is treated as the source of
 * truth, deduped by {@link buildCrewDefinition}. `founderPubkey` /
 * `foundedAt` preserve the crew's provenance across edits (foundedAt is pinned
 * to the original so editing the roster does not re-stamp the crew as founded
 * today).
 */
export async function updateCrewRoster(
  crewSecret: Uint8Array,
  crewPubkey: string,
  input: {
    name: string;
    members: readonly string[];
    founderPubkey?: string;
    foundedAt?: number;
  },
  options: PublishOptions = {},
): Promise<SignedEvent> {
  const template = buildCrewDefinition({
    name: input.name,
    mark: fingerprint(crewPubkey),
    members: input.members,
    ...(input.founderPubkey ? { founderPubkey: input.founderPubkey } : {}),
    ...(input.foundedAt !== undefined ? { createdAt: input.foundedAt } : {}),
  });
  return publishTemplate(crewSecret, crewPubkey, template, POW_BITS.post, options);
}

/**
 * Re-publish the crew's kind-0 profile (name + bio), signed by the crew's own
 * key. Same sign-and-publish shape as {@link updateCrewRoster}; the bio rides
 * as the ecosystem `about` field via {@link buildProfile}.
 */
export async function publishCrewProfile(
  crewSecret: Uint8Array,
  crewPubkey: string,
  input: { name: string; bio?: string; avatarSha256?: string },
  options: PublishOptions = {},
): Promise<SignedEvent> {
  const name = input.name.trim();
  if (!name) throw new Error('Pick a crew name first.');
  const template = buildProfile({
    tag: name,
    ...(input.bio !== undefined ? { bio: input.bio.slice(0, PROFILE_BIO_MAX) } : {}),
    // A crew has a face too — same field as a writer's kind-0. An empty string
    // clears it (buildProfile drops an empty avatar), so "take it off" works.
    ...(input.avatarSha256 !== undefined ? { avatarSha256: input.avatarSha256 } : {}),
  });
  // A crew profile is a kind 0 like any other, and the relay always charges the
  // newcomer tier for kind 0 (POW_NEW_KINDS) — mine at POST and every crew-info
  // save bounces with "that did not stick".
  return publishTemplate(crewSecret, crewPubkey, template, POW_BITS.new, options);
}

/**
 * Resolve crew pubkeys to their display names (each crew's own kind-0 `name`).
 *
 * A writer page reps crews by pubkey; showing the raw mark reads as noise, so
 * the chip wants the name. Best-effort and parallel — a crew whose profile we
 * cannot read maps to `null`, and the caller falls back to the mark.
 */
export async function fetchCrewNames(pubkeys: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  await Promise.allSettled(
    [...new Set(pubkeys)].map(async (pk) => {
      const meta = await fetchProfile(pk).catch(() => null);
      out.set(pk, meta?.name?.trim() || null);
    }),
  );
  return out;
}

/** Exposed for tests / routes that want the constant the crew definition uses. */
export { CREW_DEFINITION_DTAG };