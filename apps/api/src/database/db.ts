import { Pool, PoolClient, types } from 'pg';
import { config } from '../config/config';

// int8 (COUNT, bigint ids) -> number when safe. numeric stays string (money must not be float).
types.setTypeParser(20, (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});
// DATE -> keep 'YYYY-MM-DD' string (no timezone shifting).
types.setTypeParser(1082, (v) => v);

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function toCamelRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[camel(k)] = row[k];
  return out as T;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T>;
  maybeOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string, params?: unknown[]): Promise<number>;
}

class Executor implements Queryable {
  constructor(private readonly target: Pool | PoolClient) {}
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.target.query(sql, params);
    return res.rows.map((r) => toCamelRow<T>(r));
  }
  async one<T>(sql: string, params: unknown[] = []): Promise<T> {
    const rows = await this.query<T>(sql, params);
    if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
    return rows[0];
  }
  async maybeOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }
  async exec(sql: string, params: unknown[] = []): Promise<number> {
    const res = await this.target.query(sql, params);
    return res.rowCount ?? 0;
  }
}

export type Tx = Queryable;

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock

/** Thin, explicit data access. All multi-statement business operations use tx(). */
export class Database implements Queryable {
  readonly pool: Pool;
  private readonly exec_: Executor;

  constructor(connectionString = config().DATABASE_URL, max = config().DATABASE_POOL_MAX) {
    this.pool = new Pool({
      connectionString,
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: config().DATABASE_STATEMENT_TIMEOUT_MS,
      application_name: 'smart-pharmacy-api',
    });
    this.pool.on('error', () => {
      /* idle client errors are surfaced on next query; avoid crashing the process */
    });
    this.exec_ = new Executor(this.pool);
  }

  query<T>(sql: string, params?: unknown[]) { return this.exec_.query<T>(sql, params); }
  one<T>(sql: string, params?: unknown[]) { return this.exec_.one<T>(sql, params); }
  maybeOne<T>(sql: string, params?: unknown[]) { return this.exec_.maybeOne<T>(sql, params); }
  exec(sql: string, params?: unknown[]) { return this.exec_.exec(sql, params); }

  /**
   * Runs fn in a transaction. Deadlocks / serialization failures are retried with jitter, so
   * callers must keep fn free of non-transactional side effects (use the job outbox instead).
   */
  async tx<T>(fn: (tx: Tx) => Promise<T>, opts: { retries?: number; serializable?: boolean } = {}): Promise<T> {
    const retries = opts.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query(opts.serializable ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN');
        const result = await fn(new Executor(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const code = (err as { code?: string }).code;
        if (code && RETRYABLE.has(code) && attempt < retries) {
          await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * (attempt + 1)));
          continue;
        }
        throw err;
      } finally {
        client.release();
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
