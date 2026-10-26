import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { config } from '../../config/config';
import { safeEqual } from '../crypto';
import { Errors } from '../errors';
import { requestContext } from '../request-context';
import { SecurityEventsService } from '../security-events.service';
import { ADMIN_KEY, AuthContext, ORG_PERMISSION_KEY, OrgContext, OrgPermissionOptions, PUBLIC_KEY } from './decorators';
import { READ_ONLY_PERMISSIONS, roleHasPermission } from './permissions';
import { SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AuthedRequest = Request & { auth?: AuthContext | null; org?: OrgContext; skipCsrf?: boolean };

/**
 * Global guard: every route is protected unless marked @Public(). All authorization decisions
 * are made here on the server from fresh database state (membership role, org status,
 * verification) — never from client-provided claims.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly security: SecurityEventsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets) ?? false;

    const auth = await this.sessions.authenticate(req);
    req.auth = auth;
    if (auth) requestContext.setUser(auth.user.id);

    // CSRF: cookie-authenticated state-changing requests must echo the session-bound token.
    if (auth && !SAFE_METHODS.has(req.method) && !req.skipCsrf) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || !safeEqual(header, auth.csrfToken)) {
        await this.security.record('CSRF_REJECTED', 'WARNING', { path: req.path, userId: auth.user.id });
        throw Errors.forbidden('Missing or invalid CSRF token', 'CSRF_FAILED');
      }
    }

    if (isPublic) return true;
    if (!auth) throw Errors.unauthenticated();

    if (this.reflector.getAllAndOverride<boolean>(ADMIN_KEY, targets)) {
      if (auth.user.platformRole !== 'SUPER_ADMIN') {
        await this.security.record('ADMIN_ACCESS_DENIED', 'WARNING', { path: req.path, userId: auth.user.id });
        throw Errors.forbidden();
      }
      if (config().ADMIN_MFA_REQUIRED && !(auth.user.mfaEnabled && auth.mfaVerified)) {
        throw Errors.forbidden('Multi-factor authentication is required for administrator access', 'MFA_REQUIRED');
      }
    }

    const orgOpts = this.reflector.getAllAndOverride<OrgPermissionOptions>(ORG_PERMISSION_KEY, targets);
    if (orgOpts) {
      const rawOrgId = req.params.orgId as string | string[] | undefined;
      const orgId = Array.isArray(rawOrgId) ? rawOrgId[0] : rawOrgId;
      if (!orgId || !UUID_RE.test(orgId)) throw Errors.badRequest('Invalid organization id');
      const m = auth.memberships.find((x) => x.organizationId === orgId);
      // Non-members get 404 (not 403) so organization existence is not disclosed.
      if (!m) {
        await this.security.record('ORG_ACCESS_DENIED', 'WARNING', { path: req.path, userId: auth.user.id, orgId });
        throw Errors.notFound('Organization');
      }
      if (orgOpts.orgType && m.type !== orgOpts.orgType) {
        throw Errors.forbidden(`This action is only available to ${orgOpts.orgType.toLowerCase()} organizations`);
      }
      if (!roleHasPermission(m.role, orgOpts.permission)) {
        await this.security.record('PERMISSION_DENIED', 'INFO', { path: req.path, userId: auth.user.id, orgId, permission: orgOpts.permission });
        throw Errors.forbidden();
      }
      const isWrite = !READ_ONLY_PERMISSIONS.has(orgOpts.permission);
      if (isWrite && m.status !== 'ACTIVE') {
        throw Errors.forbidden('This organization is suspended; changes are disabled', 'ORG_SUSPENDED');
      }
      if (orgOpts.requireVerified && m.verificationStatus !== 'VERIFIED') {
        throw Errors.forbidden('This action requires an administrator-verified organization', 'ORG_NOT_VERIFIED');
      }
      req.org = { id: m.organizationId, type: m.type, role: m.role, verificationStatus: m.verificationStatus, status: m.status };
    }
    return true;
  }
}
