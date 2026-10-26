import { Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthContext, CurrentAuth, PlatformAdmin } from '../../common/auth/decorators';
import { ORG_PERMISSIONS } from '../../common/auth/permissions';
import { SettingsService } from '../../common/settings.service';
import { UuidParam, ZBody, ZQuery } from '../../common/zod';
import { AnalyticsService } from '../analytics/analytics.service';
import { OrganizationsService, ProfileUpdateSchema } from '../organizations/organizations.service';
import { AdminService, AuditQuerySchema, OrgQuerySchema, OrgStatusSchema, UserStatusSchema, VerificationDecisionSchema } from './admin.service';

/** Platform administration. Every route requires SUPER_ADMIN (and MFA when configured). */
@ApiTags('admin')
@Controller('v1/admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly settings: SettingsService,
    private readonly orgs: OrganizationsService,
    private readonly analytics: AnalyticsService,
  ) {}

  @PlatformAdmin() @Get('overview')
  overview() { return this.admin.overview(); }

  @PlatformAdmin() @Get('verifications')
  verifications() { return this.admin.verificationQueue(); }

  @PlatformAdmin() @Post('organizations/:orgId/verification') @HttpCode(200)
  decide(@UuidParam('orgId') orgId: string, @CurrentAuth() auth: AuthContext, @ZBody(VerificationDecisionSchema) body: z.infer<typeof VerificationDecisionSchema>) {
    return this.admin.decideVerification(orgId, auth.user.id, body);
  }

  @PlatformAdmin() @Post('organizations/:orgId/status') @HttpCode(200)
  orgStatus(@UuidParam('orgId') orgId: string, @ZBody(OrgStatusSchema) body: z.infer<typeof OrgStatusSchema>) {
    return this.admin.setOrgStatus(orgId, body);
  }

  @PlatformAdmin() @Get('organizations')
  organizations(@ZQuery(OrgQuerySchema) q: z.infer<typeof OrgQuerySchema>) { return this.admin.organizations(q); }

  @PlatformAdmin() @Get('organizations/:orgId')
  async organization(@UuidParam('orgId') orgId: string) {
    return { profile: await this.orgs.profile(orgId), members: await this.orgs.members(orgId) };
  }

  @PlatformAdmin() @Patch('organizations/:orgId')
  updateOrganization(@UuidParam('orgId') orgId: string, @ZBody(ProfileUpdateSchema) body: z.infer<typeof ProfileUpdateSchema>) {
    return this.orgs.update(orgId, body, { asAdmin: true });
  }

  @PlatformAdmin() @Get('users')
  users(@ZQuery(z.object({ q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) })) q: { q?: string; page: number; pageSize: number }) {
    return this.admin.users(q.q, q.page, q.pageSize);
  }

  @PlatformAdmin() @Post('users/:userId/status') @HttpCode(200)
  userStatus(@UuidParam('userId') userId: string, @CurrentAuth() auth: AuthContext, @ZBody(UserStatusSchema) body: z.infer<typeof UserStatusSchema>) {
    return this.admin.setUserStatus(userId, auth.user.id, body);
  }

  @PlatformAdmin() @Get('audit-logs')
  audit(@ZQuery(AuditQuerySchema) q: z.infer<typeof AuditQuerySchema>) { return this.admin.auditLogs(q); }

  @PlatformAdmin() @Get('security-events')
  security() { return this.admin.securityEvents(); }

  @PlatformAdmin() @Get('settings')
  listSettings() { return this.settings.list(); }

  @PlatformAdmin() @Put('settings/:key')
  updateSetting(@Param('key') key: string, @CurrentAuth() auth: AuthContext, @ZBody(z.object({ value: z.unknown() }).strict()) body: { value: unknown }) {
    return this.settings.update(key, body.value, auth.user.id).then(() => this.settings.list());
  }

  @PlatformAdmin() @Get('permissions')
  permissions() { return ORG_PERMISSIONS; }

  @PlatformAdmin() @Get('jobs')
  jobs() { return this.admin.jobsSummary(); }

  @PlatformAdmin() @Post('jobs/:jobId/retry') @HttpCode(200)
  retry(@Param('jobId', ParseIntPipe) jobId: number) { return this.admin.retryJob(jobId); }

  @PlatformAdmin() @Get('integrations')
  integrations() { return this.admin.integrationsHealth(); }

  @PlatformAdmin() @Get('ledger-check')
  ledger() { return this.admin.ledgerCheck(); }

  @PlatformAdmin() @Get('analytics')
  platformAnalytics() { return this.analytics.platform(); }
}
