import { loadConfig } from '../config';
import { createDatabase } from '../db/client';

const config = loadConfig();
const database = await createDatabase({ databaseUrl: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR });
await database.migrate(config.MIGRATIONS_DIR);
await database.close();
console.log(`Migrations applied (${database.driver}).`);
