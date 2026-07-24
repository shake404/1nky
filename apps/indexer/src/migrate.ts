import { readdir, readFile } from 'node:fs/promises';

import type { Queryable } from './types.js';

/**
 * A deliberately tiny migration runner: forward-only, one file per version,
 * each file applied inside a transaction and recorded in `schema_migrations`.
 *
 * There is no `down`. Postgres here is a rebuildable cache — the recovery
 * story for a bad migration is `docker compose down -v` plus
 * `pnpm --filter @1nky/indexer rebuild`, not a reverse script.
 */

/**
 * DDL for the bookkeeping table. Exported so `schema.test.ts` can hold it to
 * the same no-client-identifying-columns rule as the migration files.
 */
export const MIGRATIONS_TABLE_DDL = `
create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
)`;

/** Default location of the SQL files: `<package>/migrations`. */
export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

export interface Migration {
  version: string;
  sql: string;
}

/** Reads `*.sql` from `dir`, sorted by filename (which is the version). */
export async function loadMigrations(dir: URL = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir))
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));

  const out: Migration[] = [];
  for (const name of names) {
    out.push({ version: name, sql: await readFile(new URL(name, dir), 'utf8') });
  }
  return out;
}

/** Versions already recorded in `schema_migrations`. */
export async function appliedVersions(db: Queryable): Promise<Set<string>> {
  await db.query(MIGRATIONS_TABLE_DDL);
  const { rows } = await db.query<{ version: string }>('select version from schema_migrations');
  return new Set(rows.map((row) => row.version));
}

/**
 * Applies every migration that has not run yet. Returns the versions applied
 * during this call (empty when the schema was already current).
 */
export async function migrate(
  db: Queryable,
  options: { dir?: URL; migrations?: readonly Migration[] } = {},
): Promise<string[]> {
  const migrations = options.migrations ?? (await loadMigrations(options.dir ?? MIGRATIONS_DIR));
  const done = await appliedVersions(db);
  const applied: string[] = [];

  for (const migration of migrations) {
    if (done.has(migration.version)) continue;
    // Multi-statement text with no bind parameters runs in Postgres' simple
    // query protocol, so the whole file lands as one implicit transaction.
    await db.query('begin');
    try {
      await db.query(migration.sql);
      await db.query('insert into schema_migrations (version) values ($1)', [migration.version]);
      await db.query('commit');
    } catch (err) {
      await db.query('rollback').catch(() => undefined);
      throw new Error(
        `migration ${migration.version} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    applied.push(migration.version);
  }

  return applied;
}
