import { Controller, Get, Headers, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthContext, CurrentAuth, CurrentOrg, OrgAccess, OrgContext, Public } from '../../common/auth/decorators';
import { UuidParam, ZBody } from '../../common/zod';
import { CreateIntegrationSchema, IntegrationsService, IntegrationStatusSchema } from './integrations.service';

@ApiTags('integrations')
@Controller('v1')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @OrgAccess('integrations:manage')
  @Get('orgs/:orgId/integrations')
  list(@CurrentOrg() org: OrgContext) {
    return this.integrations.list(org.id);
  }

  @OrgAccess('integrations:manage', { requireVerified: true })
  @Post('orgs/:orgId/integrations')
  create(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @ZBody(CreateIntegrationSchema) body: z.infer<typeof CreateIntegrationSchema>) {
    return this.integrations.create(org.id, auth.user.id, body);
  }

  @OrgAccess('integrations:manage')
  @Post('orgs/:orgId/integrations/:integrationId/rotate-secret')
  @HttpCode(200)
  rotate(@CurrentOrg() org: OrgContext, @UuidParam('integrationId') id: string) {
    return this.integrations.rotateSecret(org.id, id);
  }

  @OrgAccess('integrations:manage')
  @Patch('orgs/:orgId/integrations/:integrationId')
  setStatus(@CurrentOrg() org: OrgContext, @UuidParam('integrationId') id: string, @ZBody(IntegrationStatusSchema) body: z.infer<typeof IntegrationStatusSchema>) {
    return this.integrations.setStatus(org.id, id, body.status);
  }

  @OrgAccess('integrations:manage')
  @Get('orgs/:orgId/integrations/:integrationId/events')
  events(@CurrentOrg() org: OrgContext, @UuidParam('integrationId') id: string) {
    return this.integrations.events(org.id, id);
  }

  /** Machine-to-machine endpoint: authenticated by HMAC signature, not by cookies (no CSRF). */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('integrations/webhooks/:integrationId')
  @HttpCode(200)
  webhook(@UuidParam('integrationId') id: string, @Headers('x-sp-timestamp') timestamp: string, @Headers('x-sp-signature') signature: string, @Req() req: Request & { rawBody?: Buffer }) {
    return this.integrations.handleWebhook(id, { timestamp, signature }, req.rawBody, req.body);
  }
}
