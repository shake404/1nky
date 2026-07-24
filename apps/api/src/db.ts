import pg from 'pg';

import type { Queryable, QueryResultLike } from './types.js';

export type { Queryable, QueryResultLike };

export interface Database extends Queryable {
  end(): Promise<void>;
}

/**
 * The read-only pool.
 *
 * `default_transaction_read_only` is set on every connection as a belt to the
 * braces of hard rule #4: even if a write statement were somehow constructed,
 * Postgres would refuse it. Writes to 1NKY are signed events sent to the
 * relay; nothing reaches the database except through the indexer.
 */
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
    options: '-c default_transaction_read_only=on',
  });
}

export function wrapPool(pool: pg.Pool): Database {
  return {
    async query<R>(text: string, params?: readonly unknown[]): Promise<QueryResultLike<R>> {
      const result = await pool.query(text, params ? Array.from(params) : undefined);
      return { rows: result.rows as R[], rowCount: result.rowCount };
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
}

export function connect(databaseUrl: string): Database {
  return wrapPool(createPool(databaseUrl));
}
