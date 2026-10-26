import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { OrgPermission, OrgRole, OrgType } from './permissions';

export const PUBLIC_KEY = 'sp:public';
export const ADMIN_KEY = 'sp:admin';
export const ORG_PERMISSION_KEY = 'sp:orgPermission';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  platformRole: 'USER' | 'SUPER_ADMIN';
  preferredLocale: 'ar' | 'en';
  mfaEnabled: boolean;
}

export interface Membership {
  organizationId: string;
  role: OrgRole;
  type: OrgType;
  nameEn: string;
  nameAr: string | null;
  verificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED';
  status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
  mfaVerified: boolean;
  csrfToken: string;
  memberships: Membership[];
}

export interface OrgContext {
  id: string;
  type: OrgType;
  role: OrgRole;
  verificationStatus: Membership['verificationStatus'];
  status: Membership['status'];
}

export interface OrgPermissionOptions {
  permission: OrgPermission;
  orgType?: OrgType;
  /** Supply-chain operations require an administrator-verified organization. */
  requireVerified?: boolean;
}

/** Endpoint is reachable without authentication (session is still resolved if present). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Platform super-administrator only (MFA-verified session when MFA is required). */
export const PlatformAdmin = () => SetMetadata(ADMIN_KEY, true);
/** Requires an active membership in the :orgId route organization with the given permission. */
export const OrgAccess = (permission: OrgPermission, opts: Omit<OrgPermissionOptions, 'permission'> = {}) =>
  SetMetadata(ORG_PERMISSION_KEY, { permission, ...opts } satisfies OrgPermissionOptions);

export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext | null => {
  return ctx.switchToHttp().getRequest().auth ?? null;
});

export const CurrentOrg = createParamDecorator((_: unknown, ctx: ExecutionContext): OrgContext => {
  return ctx.switchToHttp().getRequest().org;
});
