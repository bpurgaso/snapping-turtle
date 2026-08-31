import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, type DbHandle } from './db/client.js';
import { loadEnvFile } from './env.js';
import { loggerOptions } from './log.js';

export interface RunningServer {
  address: string;
  close(): Promise<void>;
}

/** Boot the HTTP server against the real database. Used by start.ts and dev. */
export async function startServer(existing?: DbHandle): Promise<RunningServer> {
  const config = loadConfig();
  const handle = existing ?? createDb(config.databaseUrl);
  const app = await buildApp({
    config,
    db: handle.db,
    logger: loggerOptions(config),
    checks: { database: () => handle.ping() },
  });

  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info({ publicOrigin: config.publicOrigin, nodeEnv: config.nodeEnv }, 'listening');

  const close = async () => {
    await app.close();
    await handle.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      close().then(
        () => process.exit(0),
        (err) => {
          app.log.error({ err }, 'shutdown failed');
          process.exit(1);
        },
      );
    });
  }
  return { address, close };
}

const isCli =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isCli) {
  loadEnvFile();
  await startServer();
}
