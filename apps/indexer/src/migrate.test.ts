import { describe, expect, it } from 'vitest';

import { appliedVersions, loadMigrations, migrate } from './migrate.js';
import { fakeDb } from './testing/fixtures.js';

const MIGRATIONS = [
  { version: '001_init.sql', sql: 'create table a ();' },
  { version: '002_indexes.sql', sql: 'create index i on a (x);' },
];

describe('loadMigrations', () => {
  it('reads the real migration files in filename order', async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((m) => m.version)).toEqual([
      '001_init.sql',
      '002_indexes.sql',
      '003_profile_about.sql',
      '004_videos.sql',
      '005_explore_crews.sql',
    ]);
    expect(migrations[0]?.sql).toContain('create table if not exists events');
  });

  it('is forward-only: new columns arrive in a new file, never by editing 001', async () => {
    const migrations = await loadMigrations();
    const byVersion = new Map(migrations.map((m) => [m.version, m.sql]));

    // profiles.about was added in 003. If it ever appears in 001, somebody has
    // rewritten an applied migration and every deployed database is now out of
    // step with the file that claims to describe it.
    expect(byVersion.get('001_init.sql')).not.toContain('about');
    expect(byVersion.get('003_profile_about.sql')).toContain(
      'alter table profiles add column if not exists about text',
    );
  });
});

describe('migrate', () => {
  it('creates the bookkeeping table and applies everything on a fresh database', async () => {
    const db = fakeDb();
    const applied = await migrate(db, { migrations: MIGRATIONS });

    expect(applied).toEqual(['001_init.sql', '002_indexes.sql']);
    expect(db.matching('create table if not exists schema_migrations')).toHaveLength(1);
    expect(db.matching('begin')).toHaveLength(2);
    expect(db.matching('commit')).toHaveLength(2);
    expect(db.matching('rollback')).toHaveLength(0);
  });

  it('skips versions that already ran', async () => {
    const db = fakeDb((text) =>
      text.includes('select version') ? { rows: [{ version: '001_init.sql' }], rowCount: 1 } : undefined,
    );
    const applied = await migrate(db, { migrations: MIGRATIONS });

    expect(applied).toEqual(['002_indexes.sql']);
    expect(db.matching('create index')).toHaveLength(1);
  });

  it('is a no-op when the schema is current', async () => {
    const db = fakeDb((text) =>
      text.includes('select version')
        ? { rows: MIGRATIONS.map((m) => ({ version: m.version })), rowCount: 2 }
        : undefined,
    );
    await expect(migrate(db, { migrations: MIGRATIONS })).resolves.toEqual([]);
  });

  it('rolls back and names the failing version', async () => {
    const db = fakeDb((text) => {
      if (text.includes('create index')) throw new Error('syntax error');
      return undefined;
    });

    await expect(migrate(db, { migrations: MIGRATIONS })).rejects.toThrow(
      /migration 002_indexes\.sql failed: syntax error/,
    );
    expect(db.matching('rollback')).toHaveLength(1);
  });
});

describe('appliedVersions', () => {
  it('returns a set of versions', async () => {
    const db = fakeDb((text) =>
      text.includes('select version') ? { rows: [{ version: '001_init.sql' }], rowCount: 1 } : undefined,
    );
    const versions = await appliedVersions(db);
    expect(versions.has('001_init.sql')).toBe(true);
    expect(versions.size).toBe(1);
  });
});
