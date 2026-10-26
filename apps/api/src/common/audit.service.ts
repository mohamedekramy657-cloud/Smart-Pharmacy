import { Injectable } from '@nestjs/common';
import type { Queryable } from '../database/db';
import { requestContext } from './request-context';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  organizationId?: string | null;
  summary?: string;
  changes?: Record<string, unknown>;
  actorType?: 'USER' | 'SYSTEM' | 'INTEGRATION';
  actorUserId?: string | null;
}

/** Audit rows are written inside the business transaction: no audit, no change. */
@Injectable()
export class AuditService {
  async record(tx: Queryable, e: AuditEntry): Promise<void> {
    const ctx = requestContext.get();
    await tx.exec(
      `INSERT INTO audit_logs (actor_user_id, actor_type, organization_id, action, entity_type, entity_id, summary, changes, request_id, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        e.actorUserId !== undefined ? e.actorUserId : ctx?.userId ?? null,
        e.actorType ?? (ctx?.userId ? 'USER' : 'SYSTEM'),
        e.organizationId ?? null,
        e.action,
        e.entityType,
        e.entityId ?? null,
        e.summary ?? null,
        e.changes ? JSON.stringify(e.changes) : null,
        ctx?.requestId ?? null,
        ctx?.ipHash ?? null,
      ],
    );
  }
}
