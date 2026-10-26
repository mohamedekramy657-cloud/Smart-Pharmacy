import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentOrg, OrgAccess, OrgContext } from '../../common/auth/decorators';
import { AnalyticsService } from './analytics.service';

@ApiTags('analytics')
@Controller('v1/orgs/:orgId/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @OrgAccess('analytics:read')
  @Get('dashboard')
  dashboard(@CurrentOrg() org: OrgContext) {
    return org.type === 'PHARMACY' ? this.analytics.pharmacy(org.id) : this.analytics.warehouse(org.id);
  }
}
