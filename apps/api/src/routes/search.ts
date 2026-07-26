import { Router } from 'express';

import { badRequest, oneParam, parseLimit } from '../http.js';
import {
  searchBoardTerms,
  searchQuery,
  searchThreadsQuery,
  searchVideosQuery,
  searchWritersQuery,
} from '../queries.js';
import {
  type FeedItemSource,
  type FlickSource,
  shapeFeedItem,
  shapeFlick,
  shapeThreadSummary,
  shapeWriter,
  type ThreadSummarySource,
  type WriterSource,
} from '../shape.js';
import type { Deps } from './deps.js';

const MAX_QUERY_LENGTH = 128;

/**
 * `GET /search?q=&limit=`
 *
 * Four matches over one query: the writers whose tag is what was typed, the
 * boards it implies, Postgres full-text search over captions and thread
 * subjects/bodies, and a board-tag match — so "oakland" finds the board, the
 * captions that mention it and the threads titled after it, and "shake" finds
 * SHAKE.
 *
 * The response is `{ q, boards, writers, flicks, videos, threads }`. Every
 * pre-existing field is exactly what it always was — same shape, same order — so
 * an older client keeps working and simply ignores `writers`.
 */
export function searchRoutes({ db, config }: Deps): Router {
  const router = Router();

  router.get('/search', async (req, res) => {
    const q = (oneParam(req.query['q']) ?? '').trim();
    if (q === '') throw badRequest('q is required');
    if (q.length > MAX_QUERY_LENGTH) throw badRequest(`q must be ${MAX_QUERY_LENGTH} characters or fewer`);

    const limit = parseLimit(req.query['limit'], config);

    const writersSql = searchWritersQuery(q, limit);
    const flicksSql = searchQuery(q, limit);
    const videosSql = searchVideosQuery(q, limit);
    const threadsSql = searchThreadsQuery(q, limit);

    const [writers, flicks, videos, threads] = await Promise.all([
      db.query<WriterSource>(writersSql.text, writersSql.params),
      db.query<FlickSource>(flicksSql.text, flicksSql.params),
      db.query<FeedItemSource>(videosSql.text, videosSql.params),
      db.query<ThreadSummarySource>(threadsSql.text, threadsSql.params),
    ]);

    res.json({
      q,
      boards: searchBoardTerms(q),
      writers: writers.rows.map(shapeWriter),
      flicks: flicks.rows.map(shapeFlick),
      videos: videos.rows.map(shapeFeedItem),
      threads: threads.rows.map(shapeThreadSummary),
    });
  });

  return router;
}
