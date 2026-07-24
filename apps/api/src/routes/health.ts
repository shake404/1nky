import { Router } from 'express';

import { healthQuery } from '../queries.js';
import type { Deps } from './deps.js';

/**
 * `GET /healthz` — used by the compose healthcheck.
 *
 * Pings the database, because an API that cannot read is not healthy. Returns
 * 503 rather than throwing so the error handler is not involved in a liveness
 * probe.
 */
export function healthRoutes({ db }: Deps): Router {
  const router = Router();

  router.get('/healthz', async (_req, res) => {
    const sql = healthQuery();
    try {
      await db.query(sql.text, sql.params);
    } catch {
      res.status(503).json({ status: 'degraded', db: false });
      return;
    }
    res.json({ status: 'ok', db: true });
  });

  return router;
}
