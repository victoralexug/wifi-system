import { loadConfig } from '../config';
import { createDatabase } from '../db/client';
import { admins } from '../db/schema';
import { hashPassword } from '../lib/password';

// Usage: npm run admin:create -- <email> <password>
const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 10) {
  console.error('Usage: npm run admin:create -- <email> <password>   (password must be at least 10 characters)');
  process.exit(1);
}

const config = loadConfig();
const database = await createDatabase({ databaseUrl: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR });
await database.migrate(config.MIGRATIONS_DIR);
const passwordHash = await hashPassword(password);
await database.db
  .insert(admins)
  .values({ email: email.toLowerCase(), passwordHash })
  .onConflictDoUpdate({ target: admins.email, set: { passwordHash } });
await database.close();
console.log(`Admin ${email.toLowerCase()} saved.`);
