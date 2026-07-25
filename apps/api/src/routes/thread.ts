import { Router } from 'express';

import { notFound, parseHexId } from '../http.js';
import { commentsQuery, threadQuery } from '../queries.js';
import {
  type CommentSource,
  countComments,
  shapeThread,
  type ThreadSource,
  threadComments,
} from '../shape.js';
import type { Deps } from './deps.js';

/**
 * `GET /thread/:id`
 *
 * One thread OP, its writer, and the whole reply tree nested — the same shape
 * `GET /flick/:id` returns, built by the same `threadComments`, because a reply
 * is a reply whether it hangs off a photo or off a board post.
 *
 * The whole tree comes back in one response rather than paginated: a board
 * thread is a conversation, not a feed, and the client needs the whole thing to
 * render nesting anyway.
 *
 * `replyCount` is counted off the tree that was actually returned, so it can
 * never disagree with what the reader can see — an expired or banned reply is
 * absent from both.
 */
export function threadRoutes({ db }: Deps): Router {
  const router = Router();

  router.get('/thread/:id', async (req, res) => {
    const id = parseHexId(req.params['id'], 'thread id');

    const threadSql = threadQuery(id);
    const { rows } = await db.query<ThreadSource>(threadSql.text, threadSql.params);
    const row = rows[0];
    if (!row) throw notFound('No such thread.');

    const commentsSql = commentsQuery(id);
    const comments = await db.query<CommentSource>(commentsSql.text, commentsSql.params);
    const threaded = threadComments(comments.rows, id);

    res.json({
      thread: { ...shapeThread(row), replyCount: countComments(threaded) },
      comments: threaded,
    });
  });

  return router;
}
