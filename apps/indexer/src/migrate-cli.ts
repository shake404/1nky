import { loadConfig } from './config.js';
import { connect } from './db.js';
import * as log from './log.js';
import { migrate } from './migrate.js';

/** `pnpm --filter @1nky/indexer migrate` — apply pending migrations and exit. */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = connect(config.databaseUrl);
  try {
    const applied = await migrate(db);
    log.counts('migrate', { applied: applied.length });
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  log.error('migrate', err);
  process.exitCode = 1;
});
