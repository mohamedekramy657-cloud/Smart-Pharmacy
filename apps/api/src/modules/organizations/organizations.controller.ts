import { Controller, Get, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgAccess, OrgContext } from '../../common/auth/decorators';
import { UuidParam, ZBody } from '../../common/zod';
import { AddMemberSchema, OpeningHoursSchema, OrganizationsService, ProfileUpdateSchema } from './organizations.service';

@ApiTags('organizations')
@Controller('v1/orgs/:orgId')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @OrgAccess('org:read')
  @Get()
  profile(@CurrentOrg() org: OrgContext) {
    return this.orgs.profile(org.id);
  }

  @OrgAccess('org:update')
  @Patch()
  update(@CurrentOrg() org: OrgContext, @ZBody(ProfileUpdateSchema) body: z.infer<typeof ProfileUpdateSchema>) {
    return this.orgs.update(org.id, body);
  }

  @OrgAccess('org:update')
  @Put('opening-hours')
  hours(@CurrentOrg() org: OrgContext, @ZBody(OpeningHoursSchema) body: z.infer<typeof OpeningHoursSchema>) {
    return this.orgs.setOpeningHours(org.id, body.hours);
  }

  @OrgAccess('org:read')
  @Get('members')
  members(@CurrentOrg() org: OrgContext) {
    return this.orgs.members(org.id);
  }

  @OrgAccess('members:manage')
  @Post('members')
  addMember(@CurrentOrg() org: OrgContext, @ZBody(AddMemberSchema) body: z.infer<typeof AddMemberSchema>) {
    return this.orgs.addMember(org.id, body);
  }

  @OrgAccess('members:manage')
  @Patch('members/:userId')
  updateMember(@CurrentOrg() org: OrgContext, @UuidParam('userId') userId: string,
    @ZBody(z.object({ role: z.enum(['ORG_OWNER', 'ORG_MANAGER', 'ORG_STAFF', 'ORG_VIEWER', 'REMOVE']) }).strict()) body: { role: 'ORG_OWNER' | 'ORG_MANAGER' | 'ORG_STAFF' | 'ORG_VIEWER' | 'REMOVE' }) {
    return this.orgs.updateMember(org.id, userId, body.role);
  }
}
