import { Router } from 'express';

import { nextCursor } from '../cursor.js';
import { parseCursor, parseHexId, parseLimit } from '../http.js';
import { mentionsQuery } from '../queries.js';
import { type MentionSource, shapeMention } from '../shape.js';
import type { Deps } from './deps.js';

/**
 * `GET /mentions/:pubkey?cursor=&limit=`
 *
 * Every comment that deliberately named this writer, newest first — the read
 * behind the "somebody said your name" screen.
 *
 * Only *deliberate* mentions. A comment carries `p` tags nobody typed (the
 * parent author, the thread root's author) because that is how NIP-22 addresses
 * a reply; those never reach the `mentions` table, so this endpoint is a signal
 * rather than a second copy of the reply feed. See migration 009 and
 * `isMentionTag` in `@1nky/protocol`.
 *
 * Public, like every other read here, and for the same reason: a mention is a
 * tag on a signed event that anybody could already pull from the relay with a
 * `#p` filter. What is NOT here is read state — there is no account server-side
 * to hang "seen" off, and the client keeps its own last-seen stamp on the
 * device. That is the design, not a gap.
 *
 * Nothing about this route can write. The reader's own tag never leaves their
 * device to get here; the pubkey in the path is a public identifier, and no
 * caller is authenticated, because there is nobody to authenticate.
 */
export function mentionRoutes({ db, config }: Deps): Router {
  const router = Router();

  router.get('/mentions/:pubkey', async (req, res) => {
    const pubkey = parseHexId(req.params['pubkey'], 'writer id');
    const cursor = parseCursor(req.query['cursor']);
    const limit = parseLimit(req.query['limit'], config);

    const sql = mentionsQuery({ pubkey, cursor, limit });
    const { rows } = await db.query<MentionSource>(sql.text, sql.params);

    // An empty inbox is an empty list, never a 404: a writer nobody has named
    // yet is a perfectly ordinary writer, and there is no row to be missing.
    res.json({
      mentions: rows.map(shapeMention),
      nextCursor: nextCursor(
        rows.map((row) => ({ created_at: row.created_at, event_id: row.event_id })),
        limit,
      ),
    });
  });

  return router;
}
