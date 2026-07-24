import pg from 'pg';

import type { Queryable, QueryResultLike } from './types.js';

/**
 * The `pg` wiring. Everything that touches the database takes a `Queryable`
 * (see `types.ts`), so unit tests can hand it an in-memory stub and
 * `pnpm test` never needs a live Postgres.
 */
export type { Queryable, QueryResultLike };

/** A `Queryable` that also hands out dedicated connections for transactions. */
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** `bigint` columns come back from `pg` as strings. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseInt(value, 10);
  return 0;
}

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 4 });
}

export function wrapPool(pool: pg.Pool): Database {
  return {
    async query<R>(text: string, params?: readonly unknown[]): Promise<QueryResultLike<R>> {
      const result = await pool.query(text, params ? Array.from(params) : undefined);
      return { rows: result.rows as R[], rowCount: result.rowCount };
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const tx: Queryable = {
          async query<R>(text: string, params?: readonly unknown[]): Promise<QueryResultLike<R>> {
            const result = await client.query(text, params ? Array.from(params) : undefined);
            return { rows: result.rows as R[], rowCount: result.rowCount };
          },
        };
        const out = await fn(tx);
        await client.query('commit');
        return out;
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async end(): Promise<void> {
      await pool.end();
    },
  };
}

export function connect(databaseUrl: string): Database {
  return wrapPool(createPool(databaseUrl));
}
