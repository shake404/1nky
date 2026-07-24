import { Router } from 'express';

import { badRequest, oneParam, parseLimit } from '../http.js';
import { searchBoardTerms, searchQuery } from '../queries.js';
import { type FlickSource, shapeFlick } from '../shape.js';
import type { Deps } from './deps.js';

const MAX_QUERY_LENGTH = 128;

/**
 * `GET /search?q=`
 *
 * Postgres full-text search over captions, unioned with a board-tag match, so
 * searching "oakland" finds both the board and the captions that mention it.
 * Flicks only for now — thread search lands with boards in Phase 2.
 */
export function searchRoutes({ db, config }: Deps): Router {
  const router = Router();

  router.get('/search', async (req, res) => {
    const q = (oneParam(req.query['q']) ?? '').trim();
    if (q === '') throw badRequest('q is required');
    if (q.length > MAX_QUERY_LENGTH) throw badRequest(`q must be ${MAX_QUERY_LENGTH} characters or fewer`);

    const limit = parseLimit(req.query['limit'], config);
    const sql = searchQuery(q, limit);
    const { rows } = await db.query<FlickSource>(sql.text, sql.params);

    res.json({
      q,
      boards: searchBoardTerms(q),
      flicks: rows.map(shapeFlick),
    });
  });

  return router;
}
