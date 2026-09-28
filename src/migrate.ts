import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
try {
  const applied = await migrate(db, (m) => console.log(m));
  console.log(applied.length ? `done (${applied.length} applied)` : 'already up to date');
} finally {
  await db.end();
}
