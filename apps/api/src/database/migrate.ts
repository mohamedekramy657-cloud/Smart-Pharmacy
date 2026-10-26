import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { Client } from 'pg';

/**
 * Minimal, strict migration runner:
 *  - SQL files in db/migrations applied in lexical order, each inside its own transaction
 *  - a global advisory lock prevents concurrent runners (e.g. two containers starting)
 *  - checksums detect edited, already-applied migrations (never edit applied files: add new ones)
 */
/** Locates apps/api/<rel> from both compiled (dist/src/...) and source (src/...) locations. */
export function apiPath(rel: string): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`Cannot locate ${rel} relative to ${__dirname}`);
}
export const MIGRATIONS_DIR = apiPath('db/migrations');
const LOCK_KEY = 726_150_001;

export interface MigrationResult { applied: string[]; skipped: string[] }

export async function runMigrations(databaseUrl: string, dir = MIGRATIONS_DIR, log = console.log): Promise<MigrationResult> {
  const client = new Client({ connectionString: databaseUrl, application_name: 'smart-pharmacy-migrate' });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map<string, string>(
      (await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]),
    );
    const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = applied.get(file);
      if (existing) {
        if (existing !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch). Create a new migration instead.`);
        }
        result.skipped.push(file);
        continue;
      }
      log(`applying migration ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}
