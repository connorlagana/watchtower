import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { startScheduler } from './services/scheduler.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const { app, ctx } = await buildApp(config, db);

if (config.allowPrivateNetworks) {
  app.log.warn('ALLOW_PRIVATE_NETWORKS is enabled: SSRF protection is OFF. Never use this in production.');
}
if (config.migrateOnStart) await migrate(db, (m) => app.log.info(m));

const scheduler = config.runScheduler ? startScheduler(ctx) : null;
await app.listen({ port: config.port, host: config.host });

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await scheduler?.stop();
    await db.end();
    process.exit(0);
  });
}
