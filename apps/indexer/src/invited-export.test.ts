import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  exportInvitedList,
  exportInvitedListSafe,
  invitedListEntries,
  invitedListJson,
} from './invited-export.js';
import { fakeDb, hex } from './testing/fixtures.js';

/**
 * The mirror of `banlist-export.test.ts`, for the other file the relay's write
 * policy hot-reloads. Same two things can silently break the pipeline: the JSON
 * shape `infra/strfry/write-policy.mjs` accepts, and the atomic rename that
 * stops it reading a half-written file.
 */

const A = hex('ad');
const B = hex('2b');

/**
 * The write policy's own acceptance rule, copied from
 * `infra/strfry/write-policy.mjs` (`refreshList`). If this file's output ever
 * stops satisfying it, invited writers silently go back to paying the newcomer
 * PoW tier — and nothing else in the repo would notice.
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

function invitedDb(rows: { pubkey: string }[]) {
  return fakeDb((text) =>
    text.includes('from invite_edges') ? { rows, rowCount: rows.length } : undefined,
  );
}

describe('invitedListEntries', () => {
  it('lowercases, dedupes and drops anything that is not 32-byte hex', () => {
    expect(
      invitedListEntries([
        { pubkey: A.toUpperCase() },
        { pubkey: A },
        { pubkey: 'not-a-pubkey' },
        { pubkey: B },
      ]),
    ).toEqual([A, B]);
  });

  it('is bare hex strings — the second entry shape the policy accepts', () => {
    const entries = invitedListEntries([{ pubkey: A }]);
    expect(entries).toEqual([A]);
    expect(typeof entries[0]).toBe('string');
  });
});

describe('invitedListJson', () => {
  it('produces exactly what the write policy will load', () => {
    const json = invitedListJson([{ pubkey: A }, { pubkey: B }]);
    expect(JSON.parse(json)).toEqual([A, B]);
    expect(pubkeysTheWritePolicyWouldLoad(json)).toEqual([A, B]);
  });

  it('writes an empty array — not null, not an object — when nobody is invited', () => {
    expect(JSON.parse(invitedListJson([]))).toEqual([]);
    expect(pubkeysTheWritePolicyWouldLoad(invitedListJson([]))).toEqual([]);
  });

  it('carries no reason, no inviter and nothing about the tree', () => {
    // The relay's only use for this list is the PoW tier. Anything else would be
    // publishing the invite graph to a process that has no need for it.
    const json = invitedListJson([{ pubkey: A }]);
    expect(json).not.toContain('inviter');
    expect(json).not.toContain('parent');
    expect(json).not.toContain('reason');
  });
});

describe('exportInvitedList', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), '1nky-invited-'));
    path = join(dir, 'invited.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the file the relay hot-reloads', async () => {
    const db = invitedDb([{ pubkey: A }, { pubkey: B }]);

    await expect(exportInvitedList(db, path)).resolves.toBe(2);
    expect(pubkeysTheWritePolicyWouldLoad(await readFile(path, 'utf8'))).toEqual([A, B]);
  });

  it('leaves no .tmp behind — the write is a rename, not an in-place edit', async () => {
    await exportInvitedList(invitedDb([{ pubkey: A }]), path);
    expect(await readdir(dir)).toEqual(['invited.json']);
  });

  it('replaces an existing list in one step', async () => {
    await writeFile(path, JSON.stringify([B]), 'utf8');
    await exportInvitedList(invitedDb([{ pubkey: A }]), path);

    expect(pubkeysTheWritePolicyWouldLoad(await readFile(path, 'utf8'))).toEqual([A]);
    expect(await readdir(dir)).toEqual(['invited.json']);
  });

  it('reads every child in a stable order, so a no-op export does not churn mtime', async () => {
    const db = invitedDb([{ pubkey: A }]);
    await exportInvitedList(db, path);
    expect(db.calls[0]?.text).toContain('order by child');

    const first = await readFile(path, 'utf8');
    await exportInvitedList(invitedDb([{ pubkey: A }]), path);
    expect(await readFile(path, 'utf8')).toBe(first);
  });

  it('no-ops when the export path is unset, without querying at all', async () => {
    const db = invitedDb([{ pubkey: A }]);
    await expect(exportInvitedList(db, undefined)).resolves.toBeNull();
    await expect(exportInvitedList(db, '   ')).resolves.toBeNull();
    expect(db.calls).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('exportInvitedListSafe', () => {
  it('swallows a filesystem failure — a full disk does not stop ingestion', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const db = invitedDb([{ pubkey: A }]);
      await expect(
        exportInvitedListSafe(db, join(tmpdir(), '1nky-no-such-dir-42', 'invited.json')),
      ).resolves.toBeUndefined();

      const logged = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(logged).toContain('invited list export failed');
      // Hard rule #1: whatever went wrong, no pubkey is ever named.
      expect(logged).not.toContain(A);
    } finally {
      stderr.mockRestore();
    }
  });

  it('says nothing at all when the export is disabled', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await exportInvitedListSafe(invitedDb([]), undefined);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});
