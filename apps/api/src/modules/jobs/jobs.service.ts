import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { hostname } from 'os';
import { config } from '../../config/config';
import { Database, Queryable } from '../../database/db';
import { metrics } from '../health/metrics';

export interface EnqueueOptions { runAt?: Date; dedupeKey?: string; maxAttempts?: number }
export type JobHandler = (payload: Record<string, unknown>, job: JobRow) => Promise<void>;
export interface JobRow { id: number; type: string; payload: Record<string, unknown>; attempts: number; maxAttempts: number }
interface PeriodicTask { name: string; everyMs: number; lockKey: number; run: () => Promise<void>; lastRun: number }

/** Exponential backoff with full jitter: ~5s, 10s, 20s ... capped at 1h. */
export function backoffMs(attempt: number): number {
  const base = Math.min(3_600_000, 5_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/**
 * PostgreSQL-backed job queue (transactional outbox). enqueue() must be called with the
 * business transaction so jobs exist iff the business change committed.
 */
@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private readonly handlers = new Map<string, JobHandler>();
  private readonly periodic: PeriodicTask[] = [];
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopping = false;
  private readonly workerId = `${hostname()}:${process.pid}`;

  constructor(private readonly db: Database) {}

  async enqueue(tx: Queryable, type: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<void> {
    await tx.exec(
      `INSERT INTO jobs (type, payload, run_at, dedupe_key, max_attempts) VALUES ($1, $2, coalesce($3, now()), $4, coalesce($5, 6))
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('PENDING','RUNNING','FAILED') DO NOTHING`,
      [type, JSON.stringify(payload), opts.runAt ?? null, opts.dedupeKey ?? null, opts.maxAttempts ?? null],
    );
  }

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /** Periodic maintenance task; runs on at most one instance at a time (advisory lock). */
  every(name: string, everyMs: number, run: () => Promise<void>): void {
    const lockKey = 726_200_000 + [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 99_991, 7);
    this.periodic.push({ name, everyMs, lockKey, run, lastRun: 0 });
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), config().WORKER_POLL_MS);
    this.logger.log(`worker ${this.workerId} started with ${this.handlers.size} handlers, ${this.periodic.length} periodic tasks`);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (let i = 0; i < 50 && this.running; i++) await new Promise((r) => setTimeout(r, 100));
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      await this.runPeriodic();
      await this.drain(20);
    } catch (err) {
      this.logger.error({ err }, 'worker tick failed');
    } finally {
      this.running = false;
    }
  }

  private async runPeriodic(): Promise<void> {
    const now = Date.now();
    for (const task of this.periodic) {
      if (now - task.lastRun < task.everyMs) continue;
      task.lastRun = now;
      const client = await this.db.pool.connect();
      try {
        const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [task.lockKey]);
        if (!rows[0].ok) continue;
        try {
          await task.run();
        } finally {
          await client.query('SELECT pg_advisory_unlock($1)', [task.lockKey]);
        }
      } catch (err) {
        this.logger.error({ err, task: task.name }, 'periodic task failed');
      } finally {
        client.release();
      }
    }
  }

  /** Claims and processes up to `limit` ready jobs. Returns the number processed. */
  async drain(limit = 20): Promise<number> {
    // Recover jobs whose worker died mid-flight.
    await this.db.exec(
      `UPDATE jobs SET status = 'FAILED', last_error = 'worker lease expired', locked_at = NULL, locked_by = NULL
        WHERE status = 'RUNNING' AND locked_at < now() - interval '10 minutes'`,
    );
    const jobs = await this.db.query<JobRow>(
      `UPDATE jobs SET status = 'RUNNING', locked_at = now(), locked_by = $1, attempts = attempts + 1
        WHERE id IN (SELECT id FROM jobs WHERE status IN ('PENDING','FAILED') AND run_at <= now()
                     ORDER BY run_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING id, type, payload, attempts, max_attempts`,
      [this.workerId, limit],
    );
    for (const job of jobs) await this.process(job);
    return jobs.length;
  }

  private async process(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type);
    const started = Date.now();
    try {
      if (!handler) throw new Error(`no handler registered for job type ${job.type}`);
      await handler(job.payload, job);
      await this.db.exec(`UPDATE jobs SET status = 'SUCCEEDED', completed_at = now(), locked_at = NULL, last_error = NULL WHERE id = $1`, [job.id]);
      metrics.jobsProcessed.inc({ type: job.type, outcome: 'succeeded' });
    } catch (err) {
      const message = (err as Error).message?.slice(0, 1000) ?? 'unknown error';
      const dead = job.attempts >= job.maxAttempts;
      await this.db.exec(
        `UPDATE jobs SET status = $2, last_error = $3, locked_at = NULL, run_at = now() + make_interval(secs => $4::double precision / 1000) WHERE id = $1`,
        [job.id, dead ? 'DEAD' : 'FAILED', message, dead ? 0 : backoffMs(job.attempts)],
      );
      metrics.jobsProcessed.inc({ type: job.type, outcome: dead ? 'dead' : 'retry' });
      (dead ? this.logger.error.bind(this.logger) : this.logger.warn.bind(this.logger))({ jobId: job.id, type: job.type, attempts: job.attempts, err: message }, dead ? 'job dead-lettered' : 'job failed, will retry');
    } finally {
      metrics.jobDuration.observe({ type: job.type }, (Date.now() - started) / 1000);
    }
  }

  /** Admin: move a dead job back to the queue. */
  async retryDead(jobId: number): Promise<boolean> {
    const n = await this.db.exec(`UPDATE jobs SET status = 'PENDING', attempts = 0, run_at = now(), last_error = NULL WHERE id = $1 AND status = 'DEAD'`, [jobId]);
    return n === 1;
  }
}
