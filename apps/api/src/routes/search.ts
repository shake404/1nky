import { Router } from 'express';

import { badRequest, oneParam, parseLimit } from '../http.js';
import {
  searchBoardTerms,
  searchQuery,
  searchThreadsQuery,
  searchVideosQuery,
} from '../queries.js';
import {
  type FeedItemSource,
  type FlickSource,
  shapeFeedItem,
  shapeFlick,
  shapeThreadSummary,
  type ThreadSummarySource,
} from '../shape.js';
import type { Deps } from './deps.js';

const MAX_QUERY_LENGTH = 128;

/**
 * `GET /search?q=&limit=`
 *
 * Postgres full-text search over captions, thread subjects and thread bodies,
 * unioned with a board-tag match, so searching "oakland" finds the board, the
 * captions that mention it and the threads titled after it.
 *
 * The response is `{ q, boards, flicks, videos, threads }`. `flicks` is exactly
 * what it always was — same field, same shape, same order — so an older client
 * keeps working and simply ignores the two new lists.
 */
export function searchRoutes({ db, config }: Deps): Router {
  const router = Router();

  router.get('/search', async (req, res) => {
    const q = (oneParam(req.query['q']) ?? '').trim();
    if (q === '') throw badRequest('q is required');
    if (q.length > MAX_QUERY_LENGTH) throw badRequest(`q must be ${MAX_QUERY_LENGTH} characters or fewer`);

    const limit = parseLimit(req.query['limit'], config);

    const flicksSql = searchQuery(q, limit);
    const videosSql = searchVideosQuery(q, limit);
    const threadsSql = searchThreadsQuery(q, limit);

    const [flicks, videos, threads] = await Promise.all([
      db.query<FlickSource>(flicksSql.text, flicksSql.params),
      db.query<FeedItemSource>(videosSql.text, videosSql.params),
      db.query<ThreadSummarySource>(threadsSql.text, threadsSql.params),
    ]);

    res.json({
      q,
      boards: searchBoardTerms(q),
      flicks: flicks.rows.map(shapeFlick),
      videos: videos.rows.map(shapeFeedItem),
      threads: threads.rows.map(shapeThreadSummary),
    });
  });

  return router;
}
