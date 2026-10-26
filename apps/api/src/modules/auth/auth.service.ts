import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service';
import type { AuthContext } from '../../common/auth/decorators';
import { permissionsForRole } from '../../common/auth/permissions';
import { SessionService } from '../../common/auth/session.service';
import { decryptSecret, encryptSecret, sha256Hex } from '../../common/crypto';
import { AppError, Errors } from '../../common/errors';
import { SecurityEventsService } from '../../common/security-events.service';
import { Database, Tx } from '../../database/db';
import { metrics } from '../health/metrics';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp';

const COMMON_PASSWORDS = new Set(['password123', '1234567890', 'qwertyuiop', 'password1234', '12345678910', 'iloveyou123', 'admin12345', 'pharmacy123', 'welcome1234']);

export const zPassword = z.string().min(10, 'Password must be at least 10 characters').max(128)
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'Password is too common')
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and digits');
export const zEmail = z.string().trim().toLowerCase().pipe(z.email()).refine((e) => e.length <= 200);

export const RegisterSchema = z.object({
  email: zEmail,
  password: zPassword,
  fullName: z.string().trim().min(2).max(120),
  preferredLocale: z.enum(['ar', 'en']).default('ar'),
}).strict();

export const LoginSchema = z.object({
  email: zEmail,
  password: z.string().min(1).max(128),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
}).strict();

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
let dummyHash: Promise<string> | undefined;

@Injectable()
export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
  ) {}

  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async createUser(tx: Tx, input: { email: string; password: string; fullName: string; preferredLocale?: 'ar' | 'en'; phone?: string }): Promise<{ id: string }> {
    const exists = await tx.maybeOne('SELECT 1 FROM users WHERE email = $1', [input.email]);
    if (exists) throw Errors.conflict('EMAIL_TAKEN', 'An account with this email already exists');
    const user = await tx.one<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, preferred_locale, phone) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [input.email, await this.hashPassword(input.password), input.fullName, input.preferredLocale ?? 'ar', input.phone ?? null],
    );
    await tx.exec('INSERT INTO notification_preferences (user_id) VALUES ($1)', [user.id]);
    await this.audit.record(tx, { action: 'USER_REGISTERED', entityType: 'user', entityId: user.id, actorUserId: user.id });
    return user;
  }

  async login(input: z.infer<typeof LoginSchema>, req: Request): Promise<{ userId: string; token: string; csrf: string }> {
    const user = await this.db.maybeOne<{ id: string; passwordHash: string; status: string; lockedUntil: Date | null; failedLoginCount: number; mfaEnabled: boolean; mfaSecretEnc: string | null }>(
      `SELECT id, password_hash, status, locked_until, failed_login_count, mfa_enabled, mfa_secret_enc FROM users WHERE email = $1`,
      [input.email],
    );
    const invalid = () => Errors.unauthenticated('Invalid email or password, or the account is temporarily locked');

    if (!user) {
      // Equalize timing so response time does not reveal whether the email exists.
      dummyHash ??= this.hashPassword('timing-equalizer-not-a-real-password-1');
      await argon2.verify(await dummyHash, input.password).catch(() => false);
      metrics.authFailures.inc({ reason: 'unknown_user' });
      await this.security.record('LOGIN_FAILED', 'INFO', { emailHash: sha256Hex(input.email).slice(0, 16), reason: 'unknown_user' });
      throw invalid();
    }
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      metrics.authFailures.inc({ reason: 'locked' });
      await this.security.record('LOGIN_BLOCKED_LOCKED', 'WARNING', { userId: user.id });
      throw invalid();
    }
    const ok = await argon2.verify(user.passwordHash, input.password).catch(() => false);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= MAX_FAILED;
      await this.db.exec(
        `UPDATE users SET failed_login_count = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1`,
        [user.id, lock ? 0 : failed, lock, LOCK_MINUTES],
      );
      metrics.authFailures.inc({ reason: 'bad_password' });
      await this.security.record(lock ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED', lock ? 'WARNING' : 'INFO', { userId: user.id, reason: 'bad_password' });
      throw invalid();
    }
    if (user.status !== 'ACTIVE') {
      await this.security.record('LOGIN_SUSPENDED_ACCOUNT', 'WARNING', { userId: user.id });
      throw Errors.forbidden('This account is suspended', 'ACCOUNT_SUSPENDED');
    }
    if (user.mfaEnabled) {
      if (!input.totpCode) throw new AppError(401, 'MFA_REQUIRED', 'Enter the 6-digit code from your authenticator app');
      if (!user.mfaSecretEnc || !verifyTotp(decryptSecret(user.mfaSecretEnc), input.totpCode)) {
        metrics.authFailures.inc({ reason: 'bad_totp' });
        await this.security.record('MFA_FAILED', 'WARNING', { userId: user.id });
        throw invalid();
      }
    }
    await this.db.exec(`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [user.id]);
    const { token, csrf } = await this.sessions.create(user.id, user.mfaEnabled, req);
    await this.db.tx((tx) => this.audit.record(tx, { action: 'LOGIN', entityType: 'user', entityId: user.id, actorUserId: user.id }));
    return { userId: user.id, token, csrf };
  }

  async me(auth: AuthContext | null) {
    if (!auth) return { user: null, memberships: [] };
    return {
      user: auth.user,
      mfaVerified: auth.mfaVerified,
      memberships: auth.memberships.map((m) => ({ ...m, permissions: permissionsForRole(m.role) })),
    };
  }

  async setupMfa(auth: AuthContext): Promise<{ secret: string; otpauthUrl: string }> {
    if (auth.user.mfaEnabled) throw Errors.conflict('MFA_ALREADY_ENABLED', 'MFA is already enabled');
    const secret = generateTotpSecret();
    await this.db.exec('UPDATE users SET mfa_secret_enc = $2 WHERE id = $1', [auth.user.id, encryptSecret(secret)]);
    return { secret, otpauthUrl: otpauthUrl(secret, auth.user.email) };
  }

  async enableMfa(auth: AuthContext, code: string): Promise<void> {
    const row = await this.db.one<{ mfaSecretEnc: string | null; mfaEnabled: boolean }>('SELECT mfa_secret_enc, mfa_enabled FROM users WHERE id = $1', [auth.user.id]);
    if (row.mfaEnabled) throw Errors.conflict('MFA_ALREADY_ENABLED', 'MFA is already enabled');
    if (!row.mfaSecretEnc || !verifyTotp(decryptSecret(row.mfaSecretEnc), code)) throw Errors.badRequest('Invalid verification code');
    await this.db.tx(async (tx) => {
      await tx.exec('UPDATE users SET mfa_enabled = true WHERE id = $1', [auth.user.id]);
      await tx.exec('UPDATE sessions SET mfa_verified = true WHERE id = $1', [auth.sessionId]);
      await this.audit.record(tx, { action: 'MFA_ENABLED', entityType: 'user', entityId: auth.user.id });
    });
  }

  async changePassword(auth: AuthContext, current: string, next: string): Promise<void> {
    const row = await this.db.one<{ passwordHash: string }>('SELECT password_hash FROM users WHERE id = $1', [auth.user.id]);
    if (!(await argon2.verify(row.passwordHash, current).catch(() => false))) throw Errors.badRequest('Current password is incorrect');
    const hash = await this.hashPassword(next);
    await this.db.tx(async (tx) => {
      await tx.exec('UPDATE users SET password_hash = $2 WHERE id = $1', [auth.user.id, hash]);
      // Revoke every other session after a password change.
      await tx.exec(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'password_changed' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [auth.user.id, auth.sessionId]);
      await this.audit.record(tx, { action: 'PASSWORD_CHANGED', entityType: 'user', entityId: auth.user.id });
    });
  }
}
