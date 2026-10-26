import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { config } from '../../config/config';
import { Database } from '../../database/db';
import { hashIp, hmacHex, randomToken, sha256 } from '../crypto';
import type { AuthContext, AuthUser, Membership } from './decorators';

/**
 * Opaque server-side sessions. The cookie holds a random 256-bit token; only its SHA-256 is
 * stored, so a database leak does not expose usable sessions. Revocation is immediate.
 */
@Injectable()
export class SessionService {
  constructor(private readonly db: Database) {}

  get sessionCookie(): string {
    return config().COOKIE_SECURE ? '__Host-sp_session' : 'sp_session';
  }
  get csrfCookie(): string {
    return config().COOKIE_SECURE ? '__Host-sp_csrf' : 'sp_csrf';
  }

  csrfFor(token: string): string {
    return hmacHex(`csrf:${token}`).slice(0, 48);
  }

  async create(userId: string, mfaVerified: boolean, req: Request): Promise<{ token: string; csrf: string }> {
    const cfg = config();
    const token = randomToken(32);
    await this.db.exec(
      `INSERT INTO sessions (user_id, token_hash, mfa_verified, idle_expires_at, absolute_expires_at, ip_hash, user_agent)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4), now() + make_interval(hours => $5), $6, $7)`,
      [userId, sha256(token), mfaVerified, cfg.SESSION_IDLE_MINUTES, cfg.SESSION_ABSOLUTE_HOURS, hashIp(req.ip), (req.headers['user-agent'] ?? '').slice(0, 200)],
    );
    return { token, csrf: this.csrfFor(token) };
  }

  setCookies(res: Response, token: string, csrf: string): void {
    const cfg = config();
    const base = { secure: cfg.COOKIE_SECURE, sameSite: 'lax' as const, path: '/', maxAge: cfg.SESSION_ABSOLUTE_HOURS * 3600 * 1000 };
    res.cookie(this.sessionCookie, token, { ...base, httpOnly: true });
    res.cookie(this.csrfCookie, csrf, { ...base, httpOnly: false });
  }

  clearCookies(res: Response): void {
    const opts = { secure: config().COOKIE_SECURE, sameSite: 'lax' as const, path: '/' };
    res.clearCookie(this.sessionCookie, opts);
    res.clearCookie(this.csrfCookie, opts);
  }

  tokenFrom(req: Request): string | undefined {
    const t = (req.cookies as Record<string, string> | undefined)?.[this.sessionCookie];
    return typeof t === 'string' && t.length >= 32 && t.length <= 64 ? t : undefined;
  }

  async authenticate(req: Request): Promise<AuthContext | null> {
    const token = this.tokenFrom(req);
    if (!token) return null;
    const row = await this.db.maybeOne<AuthUser & { sessionId: string; mfaVerified: boolean; lastSeenAt: Date }>(
      `SELECT s.id AS session_id, s.mfa_verified, s.last_seen_at, u.id, u.email, u.full_name, u.platform_role,
              u.preferred_locale, u.mfa_enabled
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.idle_expires_at > now()
          AND s.absolute_expires_at > now() AND u.status = 'ACTIVE'`,
      [sha256(token)],
    );
    if (!row) return null;
    // Sliding idle expiry, written at most once per minute to limit write load.
    if (Date.now() - new Date(row.lastSeenAt).getTime() > 60_000) {
      await this.db.exec(
        `UPDATE sessions SET last_seen_at = now(), idle_expires_at = LEAST(absolute_expires_at, now() + make_interval(mins => $2)) WHERE id = $1`,
        [row.sessionId, config().SESSION_IDLE_MINUTES],
      );
    }
    const memberships = await this.memberships(row.id);
    const { sessionId, mfaVerified, lastSeenAt: _ignored, ...user } = row;
    return { user, sessionId, mfaVerified, csrfToken: this.csrfFor(token), memberships };
  }

  memberships(userId: string): Promise<Membership[]> {
    return this.db.query<Membership>(
      `SELECT m.organization_id, m.role, o.type, o.name_en, o.name_ar, o.verification_status, o.status
         FROM organization_members m JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 AND m.status = 'ACTIVE' ORDER BY o.name_en`,
      [userId],
    );
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await this.db.exec(`UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [sessionId, reason]);
  }

  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    return this.db.exec(`UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [userId, reason]);
  }
}
