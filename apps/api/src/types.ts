/**
 * Database-shaped types with no runtime dependency on `pg`, so route handlers
 * and query builders can be unit tested against an in-memory stub.
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
