import { exportBanListSafe } from './banlist-export.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { run, startExpirationSweep } from './indexer.js';
import * as log from './log.js';
import { migrate } from './migrate.js';

/**
 * @1nky/indexer entrypoint.
 *
 * Applies migrations, publishes the ban list, starts the NIP-40 sweep, then
 * follows the strfry firehose until the process is told to stop.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = connect(config.databaseUrl);

  const applied = await migrate(db);
  if (applied.length > 0) log.counts('migrate', { applied: applied.length });

  // Hand strfry a ban list that matches Postgres before the first event is
  // considered. `banned_pubkeys` survives a rebuild but the file lives on a bind
  // mount that may not, so the state of record is republished at every start.
  await exportBanListSafe(db, config.banListExportPath);

  const stopSweep = startExpirationSweep(db, config.sweepIntervalMs);
  log.state('started');

  try {
    await run({ db, config, sitePubkey: process.env['SITE_PUBKEY']?.trim() || undefined });
  } finally {
    stopSweep();
    await db.end().catch(() => undefined);
  }
  log.state('stopped');
}

main().catch((err: unknown) => {
  log.error('fatal', err);
  process.exitCode = 1;
});
