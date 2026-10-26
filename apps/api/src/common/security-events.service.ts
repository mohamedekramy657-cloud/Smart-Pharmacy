import { Injectable, Logger } from '@nestjs/common';
import { Database } from '../database/db';
import { requestContext } from './request-context';

export type SecuritySeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/** Security-relevant events (failed logins, denied access, CSRF, bad webhook signatures). */
@Injectable()
export class SecurityEventsService {
  private readonly logger = new Logger('Security');
  constructor(private readonly db: Database) {}

  async record(type: string, severity: SecuritySeverity, details: Record<string, unknown> & { path?: string; userId?: string } = {}): Promise<void> {
    const ctx = requestContext.get();
    const { path, userId, ...rest } = details;
    try {
      await this.db.exec(
        `INSERT INTO security_events (type, severity, user_id, ip_hash, path, details, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [type, severity, userId ?? ctx?.userId ?? null, ctx?.ipHash ?? null, path ?? null, JSON.stringify(rest), ctx?.requestId ?? null],
      );
    } catch (err) {
      // Never let security logging break the request path; still surface it in logs.
      this.logger.error({ err, type }, 'failed to persist security event');
    }
  }
}
