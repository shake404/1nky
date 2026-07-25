import { Router } from 'express';

import { nextCursor } from '../cursor.js';
import { notFound, parseCursor, parseHexId, parseLimit } from '../http.js';
import { crewHeaderQuery, crewMediaQuery, crewMembersQuery, crewReppingQuery } from '../queries.js';
import { markOf, num, type FeedItemSource, shapeFeedItem } from '../shape.js';
import type { Deps } from './deps.js';

interface CrewHeaderSource {
  pubkey: string;
  tag_name: string | null;
  city: string | null;
  avatar_sha256: string | null;
  about: string | null;
  first_seen: number | string | null;
  updated_at: number | string | null;
  crew_name: string | null;
  crew_mark: string | null;
  founder_pubkey: string | null;
  founded_at: number | string | null;
  members: string[] | null;
  verified_at: number | string | null;
  verified_by: string | null;
}

interface MemberSource {
  pubkey: string;
  tag_name: string | null;
  avatar_sha256: string | null;
}

interface ReppingSource {
  pubkey: string;
  tag_name: string | null;
  city: string | null;
  avatar_sha256: string | null;
}

/**
 * `GET /crew/:pubkey`
 *
 * A crew page: a writer page for the crew's own pubkey, plus crew-specific
 * chrome — the crew-signed roster (`members`), the site-issued verified
 * badge, and the writers who self-declared this crew (`repping`). Roster and
 * repping are kept structurally distinct: merging them would silently upgrade
 * every unilateral claim to look verified.
 */
export function crewRoutes({ db, config }: Deps): Router {
  const router = Router();

  router.get('/crew/:pubkey', async (req, res) => {
    const pubkey = parseHexId(req.params['pubkey'], 'crew id');
    const cursor = parseCursor(req.query['cursor']);
    const limit = parseLimit(req.query['limit'], config);

    const headerSql = crewHeaderQuery(pubkey);
    const headerResult = await db.query<CrewHeaderSource>(headerSql.text, headerSql.params);
    const header = headerResult.rows[0];

    const mediaSql = crewMediaQuery({ pubkey, cursor, limit });
    const mediaResult = await db.query<FeedItemSource>(mediaSql.text, mediaSql.params);

    const hasProfile =
      !!header && (header.tag_name !== null || header.crew_name !== null || header.verified_at !== null);
    if (!hasProfile && mediaResult.rows.length === 0) throw notFound('No such crew.');

    const members = header?.members ?? [];
    const reppingSql = crewReppingQuery(pubkey);
    const reppingResult = await db.query<ReppingSource>(reppingSql.text, reppingSql.params);

    let memberProfiles = new Map<string, MemberSource>();
    if (members.length > 0) {
      const membersSql = crewMembersQuery(members);
      const membersResult = await db.query<MemberSource>(membersSql.text, membersSql.params);
      memberProfiles = new Map(membersResult.rows.map((r) => [r.pubkey, r]));
    }

    const verifiedAt =
      header?.verified_at !== null && header?.verified_at !== undefined ? num(header.verified_at) : null;

    res.json({
      crew: {
        pubkey,
        tag: header?.crew_name ?? header?.tag_name ?? null,
        mark: header?.crew_mark ?? markOf(pubkey),
        avatarSha256: header?.avatar_sha256 ?? null,
        bio: header?.about && header.about.trim() ? header.about.trim() : null,
        founderPubkey: header?.founder_pubkey ?? null,
        foundedAt:
          header?.founded_at !== null && header?.founded_at !== undefined ? num(header.founded_at) : null,
        memberCount: members.length,
        verified: verifiedAt !== null,
        verifiedAt,
      },
      members: members.map((pk) => {
        const profile = memberProfiles.get(pk);
        return {
          pubkey: pk,
          tag: profile?.tag_name ?? null,
          mark: markOf(pk),
          avatarSha256: profile?.avatar_sha256 ?? null,
        };
      }),
      repping: reppingResult.rows.map((r) => ({
        pubkey: r.pubkey,
        tag: r.tag_name ?? null,
        mark: markOf(r.pubkey),
        avatarSha256: r.avatar_sha256 ?? null,
      })),
      flicks: mediaResult.rows.map(shapeFeedItem),
      nextCursor: nextCursor(
        mediaResult.rows.map((row) => ({ created_at: row.created_at, event_id: row.event_id })),
        limit,
      ),
    });
  });

  return router;
}
