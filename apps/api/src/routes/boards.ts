import { Router } from 'express';

import { boardsQuery } from '../queries.js';
import { num } from '../shape.js';
import type { Deps } from './deps.js';

interface BoardRow {
  slug: string;
  title: string;
  kind: string;
  created_at: number | string;
  flick_count: number | string;
  latest_at: number | string | null;
}

/** `GET /boards` — every board, with how busy it is. */
export function boardRoutes({ db }: Deps): Router {
  const router = Router();

  router.get('/boards', async (_req, res) => {
    const sql = boardsQuery();
    const { rows } = await db.query<BoardRow>(sql.text, sql.params);

    res.json({
      boards: rows.map((row) => ({
        slug: row.slug,
        title: row.title,
        kind: row.kind,
        createdAt: num(row.created_at),
        flickCount: num(row.flick_count),
        latestAt: row.latest_at === null ? null : num(row.latest_at),
      })),
    });
  });

  return router;
}
