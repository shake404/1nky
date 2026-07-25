import express, { type Express } from 'express';

import type { ApiConfig } from './config.js';
import { cors, errorHandler, notFoundHandler, readOnly } from './http.js';
import { boardRoutes } from './routes/boards.js';
import type { Deps } from './routes/deps.js';
import { crewRoutes } from './routes/crew.js';
import { exploreRoutes } from './routes/explore.js';
import { feedRoutes } from './routes/feed.js';
import { flickRoutes } from './routes/flick.js';
import { healthRoutes } from './routes/health.js';
import { modRoutes } from './routes/mod.js';
import { searchRoutes } from './routes/search.js';
import { writerRoutes } from './routes/writer.js';
import type { Queryable } from './types.js';

/**
 * The 1NKY read API.
 *
 * Things this app deliberately does not have, each one a hard rule:
 *
 *   - **No logging middleware.** No morgan, no access log, no `console.log` of
 *     a request. The only thing ever written to stderr is an unexpected
 *     error's message (rule #1).
 *   - **No write endpoints.** Not one. Publishing is a signed event to the
 *     relay; there is no route here that could be pointed at the database
 *     with a POST (rule #4).
 *   - **No body parser.** Nothing sends this service a body, so nothing
 *     parses one.
 *   - **No cookies, no sessions, no auth** beyond the mod shared secret.
 *     There is no account concept server-side (rule #2).
 */
export function createApp(db: Queryable, config: ApiConfig): Express {
  const app = express();
  const deps: Deps = { db, config };

  // Behind Caddy. `trust proxy` is deliberately left off: Express only uses it
  // to resolve a client IP, and this service has no use for one.
  app.disable('x-powered-by');
  app.disable('etag');

  app.use(cors);
  app.use(readOnly);

  app.use(healthRoutes(deps));
  app.use(feedRoutes(deps));
  app.use(exploreRoutes(deps));
  app.use(flickRoutes(deps));
  app.use(boardRoutes(deps));
  app.use(writerRoutes(deps));
  app.use(crewRoutes(deps));
  app.use(searchRoutes(deps));
  app.use(modRoutes(deps));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
