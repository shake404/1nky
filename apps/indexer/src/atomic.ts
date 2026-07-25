import { rename, writeFile } from 'node:fs/promises';

/**
 * Write a file the relay's write policy may read at any instant.
 *
 * The policy stats its lists once a second and re-reads the moment the mtime
 * moves. A plain `writeFile` would expose a window where the file is half
 * written — unparseable JSON. The policy is careful enough to keep its last good
 * list rather than fail open, but relying on that is not a design.
 *
 * So the bytes go to `<path>.tmp` in the SAME directory and are then renamed
 * over the target: one atomic replace, never a half file. Same directory
 * matters — a cross-device rename degrades to a copy, which is not atomic.
 *
 * Shared by both exporters (`banlist-export.ts`, `invited-export.ts`) because
 * both write files the same reader hot-reloads under the same rules.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, path);
}
