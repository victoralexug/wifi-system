import fs from 'node:fs';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DatabaseHandle {
  db: Database;
  driver: 'postgres' | 'pglite';
  migrate: (migrationsFolder: string) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Connects to Postgres when a URL is given. Otherwise it falls back to PGlite, an embedded
 * Postgres build, so local dev and tests need no database server. Use "memory://" for an
 * in-memory PGlite.
 */
export async function createDatabase(opts: {
  databaseUrl?: string;
  pgliteDir?: string;
  /** Postgres connections to keep open. Serverless functions handle one request at a time, so need few. */
  poolMax?: number;
}): Promise<DatabaseHandle> {
  if (opts.databaseUrl) {
    const { Pool } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pool = new Pool({ connectionString: opts.databaseUrl, max: opts.poolMax ?? 10 });
    const db = drizzle(pool, { schema });
    return {
      db: db as unknown as Database,
      driver: 'postgres',
      migrate: (migrationsFolder) => migrate(db, { migrationsFolder }),
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const dir = opts.pgliteDir ?? 'memory://';
  if (!dir.startsWith('memory://')) fs.mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  const db = drizzle(client, { schema });
  return {
    db: db as unknown as Database,
    driver: 'pglite',
    migrate: (migrationsFolder) => migrate(db, { migrationsFolder }),
    close: () => client.close(),
  };
}
