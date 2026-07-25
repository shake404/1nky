import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { banListEntries, banListJson, exportBanList, exportBanListSafe } from './banlist-export.js';
import { fakeDb, hex } from './testing/fixtures.js';

/**
 * The exporter is the seam between Postgres and the relay's write policy, so
 * these tests check the two things that can silently break the ban pipeline:
 * the JSON shape `infra/strfry/write-policy.mjs` accepts, and the atomic
 * rename that stops it reading a half-written file.
 */

const A = hex('be');
const B = hex('7f');

/**
 * The write policy's own acceptance rule, copied from
 * `infra/strfry/write-policy.mjs` (`refreshBanList`). If this file's output ever
 * stops satisfying it, bans stop reaching the relay door — and nothing else in
 * the repo would notice, which is why it is asserted here.
 */
function pubkeysTheWritePolicyWouldLoad(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    const pk =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object'
          ? (entry as { pubkey?: unknown }).pubkey
          : undefined;
    if (typeof pk === 'string' && /^[0-9a-f]{64}$/i.test(pk)) out.push(pk.toLowerCase());
  }
  return out;
}

function banDb(rows: { pubkey: string; reason: string | null }[]) {
  return fakeDb((text) =>
    text.includes('from banned_pubkeys') ? { rows, rowCount: rows.length } : undefined,
  );
}

describe('banListEntries', () => {
  it('lowercases, dedupes and drops anything that is not 32-byte hex', () => {
    expect(
      banListEntries([
        { pubkey: A.toUpperCase(), reason: 'illegal' },
        { pubkey: A, reason: 'again' },
        { pubkey: 'not-a-pubkey', reason: null },
        { pubkey: B, reason: null },
      ]),
    ).toEqual([
      { pubkey: A, reason: 'illegal' },
      { pubkey: B, reason: null },
    ]);
  });

  it('normalises a missing reason to null rather than omitting the entry', () => {
    expect(banListEntries([{ pubkey: A, reason: null }])).toEqual([{ pubkey: A, reason: null }]);
  });
});

describe('banListJson', () => {
  it('produces exactly what the write policy will load', () => {
    const json = banListJson([
      { pubkey: A, reason: 'illegal' },
      { pubkey: B, reason: null },
    ]);
    expect(JSON.parse(json)).toEqual([
      { pubkey: A, reason: 'illegal' },
      { pubkey: B, reason: null },
    ]);
    expect(pubkeysTheWritePolicyWouldLoad(json)).toEqual([A, B]);
  });

  it('writes an empty array — not null, not an object — when nobody is banned', () => {
    expect(JSON.parse(banListJson([]))).toEqual([]);
    expect(pubkeysTheWritePolicyWouldLoad(banListJson([]))).toEqual([]);
  });
});

describe('exportBanList', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), '1nky-banlist-'));
    path = join(dir, 'banlist.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the file the relay hot-reloads', async () => {
    const db = banDb([
      { pubkey: A, reason: 'illegal' },
      { pubkey: B, reason: null },
    ]);

    await expect(exportBanList(db, path)).resolves.toBe(2);
    const json = await readFile(path, 'utf8');
    expect(pubkeysTheWritePolicyWouldLoad(json)).toEqual([A, B]);
  });

  it('leaves no .tmp behind — the write is a rename, not an in-place edit', async () => {
    await exportBanList(banDb([{ pubkey: A, reason: null }]), path);
    expect(await readdir(dir)).toEqual(['banlist.json']);
  });

  it('replaces an existing list in one step', async () => {
    await writeFile(path, JSON.stringify([B]), 'utf8');
    await exportBanList(banDb([{ pubkey: A, reason: 'illegal' }]), path);

    expect(pubkeysTheWritePolicyWouldLoad(await readFile(path, 'utf8'))).toEqual([A]);
    expect(await readdir(dir)).toEqual(['banlist.json']);
  });

  it('writes an empty list when the last ban is lifted, rather than deleting the file', async () => {
    await exportBanList(banDb([{ pubkey: A, reason: null }]), path);
    await exportBanList(banDb([]), path);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([]);
  });

  it('no-ops when the export path is unset, without querying at all', async () => {
    const db = banDb([{ pubkey: A, reason: null }]);
    await expect(exportBanList(db, undefined)).resolves.toBeNull();
    await expect(exportBanList(db, '   ')).resolves.toBeNull();
    expect(db.calls).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('exportBanListSafe', () => {
  it('swallows a filesystem failure — a full disk does not stop ingestion', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const db = banDb([{ pubkey: A, reason: null }]);
      // A directory that does not exist: writeFile rejects with ENOENT.
      await expect(
        exportBanListSafe(db, join(tmpdir(), '1nky-no-such-dir-42', 'banlist.json')),
      ).resolves.toBeUndefined();

      const logged = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(logged).toContain('banlist export failed');
      // Hard rule #1: whatever went wrong, no pubkey is ever named.
      expect(logged).not.toContain(A);
    } finally {
      stderr.mockRestore();
    }
  });

  it('says nothing at all when the export is disabled', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await exportBanListSafe(banDb([]), undefined);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});
