import { Router } from 'express';

import { notFound, parseHexId } from '../http.js';
import { commentsQuery, flickQuery } from '../queries.js';
import {
  type CommentSource,
  countComments,
  type FlickSource,
  shapeFlick,
  threadComments,
} from '../shape.js';
import type { Deps } from './deps.js';

/**
 * `GET /flick/:id`
 *
 * One flick, its writer, and the whole comment thread nested. Threads here
 * are small (a flick is not a forum), so the entire thread is returned in one
 * response rather than paginated.
 */
export function flickRoutes({ db }: Deps): Router {
  const router = Router();

  router.get('/flick/:id', async (req, res) => {
    const id = parseHexId(req.params['id'], 'flick id');

    const flickSql = flickQuery(id);
    const { rows } = await db.query<FlickSource>(flickSql.text, flickSql.params);
    const row = rows[0];
    if (!row) throw notFound('No such flick.');

    const commentsSql = commentsQuery(id);
    const comments = await db.query<CommentSource>(commentsSql.text, commentsSql.params);
    const threaded = threadComments(comments.rows, id);

    res.json({
      flick: { ...shapeFlick(row), replyCount: countComments(threaded) },
      comments: threaded,
    });
  });

  return router;
}
