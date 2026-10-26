import { Injectable } from '@nestjs/common';
import { Database, Tx } from '../database/db';
import { sha256Hex, stableStringify } from './crypto';
import { Errors } from './errors';

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

/**
 * Runs a business operation exactly once per (scope, Idempotency-Key). The record is written in
 * the same transaction as the operation; a transaction-scoped advisory lock serializes
 * concurrent duplicates so the second caller receives the stored response instead of an error.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly db: Database) {}

  static validateKey(key: string | undefined): string | undefined {
    if (key === undefined || key === '') return undefined;
    if (!KEY_RE.test(key)) throw Errors.badRequest('Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-:.]');
    return key;
  }

  async execute<T>(scope: string, key: string | undefined, request: unknown, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const idemKey = IdempotencyService.validateKey(key);
    return this.db.tx(async (tx) => {
      if (idemKey) {
        const hash = sha256Hex(stableStringify(request ?? null));
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${scope}|${idemKey}`]);
        const existing = await tx.maybeOne<{ requestHash: string; response: T }>(
          'SELECT request_hash, response FROM idempotency_records WHERE scope = $1 AND idempotency_key = $2',
          [scope, idemKey],
        );
        if (existing) {
          if (existing.requestHash !== hash) {
            throw Errors.unprocessable('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request');
          }
          return existing.response;
        }
        const result = await fn(tx);
        await tx.exec(
          'INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response) VALUES ($1, $2, $3, $4)',
          [scope, idemKey, hash, JSON.stringify(result ?? null)],
        );
        return result;
      }
      return fn(tx);
    });
  }
}
