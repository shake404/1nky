import { normalizeBoard } from '@1nky/protocol';
import { Router } from 'express';

import { nextCursor } from '../cursor.js';
import { badRequest, oneParam, parseCursor, parseLimit } from '../http.js';
import { happeningsQuery } from '../queries.js';
import { type HappeningSource, shapeHappening } from '../shape.js';
import type { Deps } from './deps.js';

/**
 * `GET /happenings?city=&cursor=&limit=`
 *
 * What is coming up: threads somebody put a date on, soonest first.
 *
 * A happening is not a new kind of post — it is a thread carrying a date, so it
 * has a board page, replies, a writer and an expiry exactly like any other, and
 * this endpoint is only a different *sort* over the same rows. That is also why
 * the page bound is the date rather than the post time: the list is ordered by
 * when things happen, so the keyset cursor has to be too.
 *
 * Past happenings drop off on their own. `buildThreadOp` gives a happening a
 * NIP-40 expiry of a week after the event, so the relay removes it and the
 * indexer's sweep follows; the query re-applies that same week from the date
 * itself, so one published with a longer expiry still leaves the list on time.
 */
export function happeningRoutes({ db, config }: Deps): Router {
  const router = Router();

  router.get('/happenings', async (req, res) => {
    const rawCity = oneParam(req.query['city'])?.trim() ?? '';
    const city = normalizeBoard(rawCity);
    // A city that survives normalisation as nothing (`?city=???`) is a filter
    // that can never match, so say so rather than quietly returning everything.
    if (rawCity !== '' && city === '') throw badRequest('city must be a slug');

    const cursor = parseCursor(req.query['cursor']);
    const limit = parseLimit(req.query['limit'], config);

    const sql = happeningsQuery({ city: city === '' ? undefined : city, cursor, limit });
    const { rows } = await db.query<HappeningSource>(sql.text, sql.params);

    res.json({
      happenings: rows.map(shapeHappening),
      nextCursor: nextCursor(
        // The page bound is the happening's date, not when it was posted.
        rows.map((row) => ({ created_at: row.happening_at ?? 0, event_id: row.event_id })),
        limit,
      ),
    });
  });

  return router;
}
