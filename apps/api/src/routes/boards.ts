import { normalizeBoard } from '@1nky/protocol';
import { Router } from 'express';

import { nextCursor } from '../cursor.js';
import { badRequest, notFound, oneParam, parseCursor, parseLimit } from '../http.js';
import { boardQuery, boardsQuery, boardThreadsQuery } from '../queries.js';
import { num, shapeThreadSummary, type ThreadSummarySource } from '../shape.js';
import type { Deps } from './deps.js';

interface BoardListRow {
  slug: string;
  title: string;
  kind: string;
  region_slug: string | null;
  created_at: number | string;
  flick_count: number | string;
  thread_count: number | string;
  latest_at: number | string | null;
}

interface BoardHeaderRow {
  slug: string;
  title: string | null;
  kind: string | null;
  region_slug: string | null;
  has_media: boolean;
}

/**
 * The facets `?kind=` accepts. Anything else is a 400, not an empty list.
 *
 * `happening` is the marker slug every happening carries (see `GET /happenings`);
 * it is its own kind so that asking for cities never returns a board called
 * "happening".
 */
const BOARD_KINDS = new Set(['city', 'type', 'surface', 'region', 'legal', 'happening']);

/**
 * `GET /boards?kind=` — every board, with how busy it is.
 * `GET /board/:slug` — one board's threads, liveliest first.
 */
export function boardRoutes({ db, config }: Deps): Router {
  const router = Router();

  router.get('/boards', async (req, res) => {
    const kind = oneParam(req.query['kind'])?.trim().toLowerCase();
    if (kind !== undefined && kind !== '' && !BOARD_KINDS.has(kind)) {
      throw badRequest(`kind must be one of ${[...BOARD_KINDS].join(', ')}`);
    }

    const sql = boardsQuery(kind === '' ? undefined : kind);
    const { rows } = await db.query<BoardListRow>(sql.text, sql.params);

    res.json({
      boards: rows.map((row) => ({
        slug: row.slug,
        title: row.title,
        kind: row.kind,
        regionSlug: row.region_slug ?? null,
        createdAt: num(row.created_at),
        flickCount: num(row.flick_count),
        threadCount: num(row.thread_count),
        latestAt: row.latest_at === null ? null : num(row.latest_at),
      })),
    });
  });

  /**
   * One board. Threads are keyset paginated on
   * `(greatest(created_at, last_reply_at), event_id) desc`, so a thread that
   * gets a reply floats to the top without a page boundary shifting underneath
   * a reader.
   *
   * A board that was never registered but that writers have been tagging is a
   * real board — it 200s. Only a slug with no registry row, no threads and no
   * media is a 404.
   */
  router.get('/board/:slug', async (req, res) => {
    const slug = normalizeBoard(req.params['slug'] ?? '');
    if (slug === '') throw badRequest('board must be a slug');

    const cursor = parseCursor(req.query['cursor']);
    const limit = parseLimit(req.query['limit'], config);

    const boardSql = boardQuery(slug);
    const boardResult = await db.query<BoardHeaderRow>(boardSql.text, boardSql.params);

    const threadsSql = boardThreadsQuery({ slug, cursor, limit });
    const threadsResult = await db.query<ThreadSummarySource & { sort_at: number | string }>(
      threadsSql.text,
      threadsSql.params,
    );

    const header = boardResult.rows[0];
    const registered = header?.title !== null && header?.title !== undefined;
    if (!registered && header?.has_media !== true && threadsResult.rows.length === 0) {
      throw notFound('No such board.');
    }

    res.json({
      board: {
        slug,
        title: header?.title ?? slug,
        kind: header?.kind ?? 'city',
        regionSlug: header?.region_slug ?? null,
      },
      threads: threadsResult.rows.map(shapeThreadSummary),
      nextCursor: nextCursor(
        // The page bound is the activity sort key, not the OP's own timestamp.
        threadsResult.rows.map((row) => ({ created_at: row.sort_at, event_id: row.event_id })),
        limit,
      ),
    });
  });

  return router;
}
