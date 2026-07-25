import { normalizeBoard } from '@1nky/protocol';
import { Router } from 'express';

import { nextCursor } from '../cursor.js';
import { oneParam, parseCursor, parseLimit } from '../http.js';
import { feedQuery } from '../queries.js';
import { type FeedItemSource, shapeFeedItem } from '../shape.js';
import type { Deps } from './deps.js';

/**
 * `GET /feed?board=&cursor=&limit=`
 *
 * The global feed, or one board's. Flicks and videos are unified into one
 * stream ordered by `(created_at, event_id) desc` so new posts landing at the
 * top never shift a page boundary underneath a scrolling reader. Each item
 * carries a `mediaType` so the client renders an `<img>` or a `<video>`.
 */
export function feedRoutes({ db, config }: Deps): Router {
  const router = Router();

  router.get('/feed', async (req, res) => {
    const rawBoard = oneParam(req.query['board']);
    const board = rawBoard ? normalizeBoard(rawBoard) || undefined : undefined;
    const cursor = parseCursor(req.query['cursor']);
    const limit = parseLimit(req.query['limit'], config);

    const sql = feedQuery({ board, cursor, limit });
    const { rows } = await db.query<FeedItemSource>(sql.text, sql.params);

    res.json({
      board: board ?? null,
      flicks: rows.map(shapeFeedItem),
      nextCursor: nextCursor(
        rows.map((row) => ({ created_at: row.created_at, event_id: row.event_id })),
        limit,
      ),
    });
  });

  return router;
}
