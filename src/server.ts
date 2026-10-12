import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { loadBoardUrls, syncBoardIndex } from './services/boardIndex.js';
import { startScheduler } from './services/scheduler.js';
import { startAlerts } from './services/alerts.js';

const config = loadConfig();
// Logged straight to stderr: the pool exists before the app's logger does.
const db = createPool(config.databaseUrl, (err) => console.error(JSON.stringify({ level: 50, time: Date.now(), msg: 'database connection error', err: err.message })));
const { app, ctx } = await buildApp(config, db);

if (config.allowPrivateNetworks) {
  app.log.warn('ALLOW_PRIVATE_NETWORKS is enabled: SSRF protection is OFF. Never use this in production.');
}
if (config.migrateOnStart) await migrate(db, (m) => app.log.info(m));
// The board directory is what search watches (no URL) are matched against. With INDEX_ENABLED=false it is emptied.
await syncBoardIndex(ctx, await loadBoardUrls(config)).catch((err) => app.log.error({ err }, 'board directory sync failed'));

const scheduler = config.runScheduler ? startScheduler(ctx) : null;
// Daily alert emails for website accounts (only with RESEND_API_KEY), on the same replicas that run the scheduler.
const alerts = config.runScheduler ? startAlerts(ctx) : null;
await app.listen({ port: config.port, host: config.host });

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
    alerts?.stop();
    await scheduler?.stop();
    await db.end();
    process.exit(0);
  });
}
