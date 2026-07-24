import { loadConfig } from './config.js';
import { connect } from './db.js';
import { run } from './indexer.js';
import * as log from './log.js';
import { migrate } from './migrate.js';
import { truncateDerived } from './store.js';

/**
 * `pnpm --filter @1nky/indexer rebuild`
 *
 * Postgres is a cache; the relay is the source of truth. This throws the
 * cache away and replays it:
 *
 *   1. apply any pending migrations
 *   2. truncate every derived table (NOT `banned_pubkeys` — a rebuild must
 *      never unban anyone)
 *   3. re-request the whole firehose from `since: 0` and index it
 *   4. exit once the relay signals end-of-stored-events
 *
 * Pass `--follow` to keep following the live stream afterwards instead of
 * exiting, which is what you want if you are rebuilding in place with the
 * normal indexer container stopped.
 */
/** How many times a rebuild will try the relay before giving up. */
const REBUILD_MAX_ATTEMPTS = 10;

async function main(): Promise<void> {
  const follow = process.argv.includes('--follow');
  const config = loadConfig();
  const db = connect(config.databaseUrl);

  try {
    await migrate(db);
    await truncateDerived(db);
    log.state('truncated');

    const counters = await run({
      db,
      config,
      sitePubkey: process.env['SITE_PUBKEY']?.trim() || undefined,
      once: !follow,
      // A rebuild is a command, not a daemon: if the relay never answers,
      // say so and exit instead of retrying until someone notices.
      ...(follow ? {} : { maxAttempts: REBUILD_MAX_ATTEMPTS }),
    });
    log.counts('rebuilt', { ...counters });

    if (counters.connections === 0) {
      throw new Error(`relay unreachable after ${String(REBUILD_MAX_ATTEMPTS)} attempts`);
    }
  } finally {
    await db.end().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  log.error('rebuild', err);
  process.exitCode = 1;
});
