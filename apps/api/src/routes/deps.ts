import type { ApiConfig } from '../config.js';
import type { Queryable } from '../types.js';

/** What every route needs: a way to read, and the limits it must respect. */
export interface Deps {
  db: Queryable;
  config: ApiConfig;
}
