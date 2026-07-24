import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';

/**
 * @1nky/api entrypoint. Read-only REST over the Postgres index.
 *
 * Startup writes one line to stderr — a port number, nothing about anyone.
 */
function main(): void {
  const config = loadConfig();
  const db = connect(config.databaseUrl);
  const app = createApp(db, config);

  const server = app.listen(config.port, () => {
    process.stderr.write(`listening ${String(config.port)}\n`);
    if (!config.modApiKey) {
      process.stderr.write('warning: MOD_API_KEY unset, /mod/* disabled\n');
    }
  });

  const shutdown = (): void => {
    server.close(() => {
      void db.end().finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

try {
  main();
} catch (err) {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
