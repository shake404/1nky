import { Router } from 'express';

import { nextCursor } from '../cursor.js';
import { notFound, parseCursor, parseHexId, parseLimit } from '../http.js';
import { profileQuery, writerFlicksQuery } from '../queries.js';
import {
  type FlickSource,
  markOf,
  type ProfileSource,
  shapeFlick,
  shapeProfile,
} from '../shape.js';
import type { Deps } from './deps.js';

/**
 * `GET /writer/:pubkey`
 *
 * A writer's page: their tag, their mark, and their flicks. Buffed flicks are
 * excluded — a writer who scrapped a piece does not want it on their wall.
 *
 * A writer with flicks but no profile event still resolves: the tag is null
 * and the mark carries the identity, which is the whole point of the mark.
 */
export function writerRoutes({ db, config }: Deps): Router {
  const router = Router();

  router.get('/writer/:pubkey', async (req, res) => {
    const pubkey = parseHexId(req.params['pubkey'], 'writer id');
    const cursor = parseCursor(req.query['cursor']);
    const limit = parseLimit(req.query['limit'], config);

    const profileSql = profileQuery(pubkey);
    const profileResult = await db.query<ProfileSource>(profileSql.text, profileSql.params);

    const flicksSql = writerFlicksQuery({ pubkey, cursor, limit });
    const flicksResult = await db.query<FlickSource>(flicksSql.text, flicksSql.params);

    const profileRow = profileResult.rows[0];
    if (!profileRow && flicksResult.rows.length === 0) throw notFound('No such writer.');

    const writer = profileRow
      ? shapeProfile(profileRow)
      : {
          pubkey,
          tag: null,
          mark: markOf(pubkey),
          avatarSha256: null,
          firstSeen: null,
          updatedAt: null,
          eventCount: 0,
          banned: false,
        };

    res.json({
      writer,
      flicks: flicksResult.rows.map((row) => shapeFlick({ ...row, pubkey })),
      nextCursor: nextCursor(
        flicksResult.rows.map((row) => ({ created_at: row.created_at, event_id: row.event_id })),
        limit,
      ),
    });
  });

  return router;
}
