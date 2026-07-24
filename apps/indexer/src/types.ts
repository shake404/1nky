/**
 * Database-shaped types with no runtime dependency on `pg`.
 *
 * Keeping these here means the pure modules (mappers, queries, store) never
 * import the driver, so `vitest` can exercise them against an in-memory stub
 * and `pnpm test` never needs a live Postgres.
 */

export interface QueryResultLike<R> {
  rows: R[];
  rowCount: number | null;
}

export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResultLike<R>>;
}

/** A statement plus its bind parameters. Values are never interpolated. */
export interface Sql {
  text: string;
  params: unknown[];
}
