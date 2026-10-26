import { Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthContext, CurrentAuth, CurrentOrg, OrgAccess, OrgContext } from '../../common/auth/decorators';
import { UuidParam, ZBody, ZQuery } from '../../common/zod';
import { FulfillHoldSchema, RequestsService, RespondSchema } from './requests.service';

/** Pharmacy side of patient confirmation requests and holds. */
@ApiTags('pharmacy-requests')
@Controller('v1/orgs/:orgId')
export class PharmacyRequestsController {
  constructor(private readonly requests: RequestsService) {}

  @OrgAccess('inventory:read', { orgType: 'PHARMACY' })
  @Get('confirmation-requests')
  list(@CurrentOrg() org: OrgContext, @ZQuery(z.object({ status: z.string().max(30).optional() })) q: { status?: string }) {
    return this.requests.listForPharmacy(org.id, q.status);
  }

  @OrgAccess('requests:respond', { orgType: 'PHARMACY', requireVerified: true })
  @Post('confirmation-requests/:requestId/respond')
  @HttpCode(200)
  respond(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('requestId') id: string, @ZBody(RespondSchema) body: z.infer<typeof RespondSchema>, @Headers('idempotency-key') idem?: string) {
    return this.requests.respond(org, auth.user.id, id, body, idem);
  }

  @OrgAccess('inventory:read', { orgType: 'PHARMACY' })
  @Get('holds')
  holds(@CurrentOrg() org: OrgContext) {
    return this.requests.activeHolds(org.id);
  }

  @OrgAccess('requests:respond', { orgType: 'PHARMACY', requireVerified: true })
  @Post('holds/:holdId/fulfill')
  @HttpCode(200)
  fulfill(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('holdId') id: string, @ZBody(FulfillHoldSchema) body: z.infer<typeof FulfillHoldSchema>) {
    return this.requests.fulfillHold(org, auth.user.id, id, body.pickupCode);
  }

  @OrgAccess('requests:respond', { orgType: 'PHARMACY', requireVerified: true })
  @Post('holds/:holdId/release')
  @HttpCode(200)
  release(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('holdId') id: string) {
    return this.requests.releaseHold(org, auth.user.id, id);
  }
}
