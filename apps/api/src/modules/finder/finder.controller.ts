import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Public } from '../../common/auth/decorators';
import { UuidParam, ZQuery } from '../../common/zod';
import { config } from '../../config/config';
import { OrganizationsService } from '../organizations/organizations.service';
import { FinderSearchSchema, FinderService } from './finder.service';

/** Public patient finder. No account required; no personal data is stored for searches. */
@ApiTags('finder')
@Controller('v1')
export class FinderController {
  constructor(private readonly finder: FinderService, private readonly orgs: OrganizationsService) {}

  @Public()
  @Throttle({ default: { limit: () => config().FINDER_RATE_LIMIT_PER_MINUTE, ttl: 60_000 } })
  @Get('finder/search')
  search(@ZQuery(FinderSearchSchema as unknown as z.ZodObject) q: z.infer<typeof FinderSearchSchema>) {
    return this.finder.search(q);
  }

  @Public()
  @Get('finder/pharmacies/:id')
  pharmacy(@UuidParam('id') id: string) {
    return this.orgs.publicPharmacy(id);
  }

  @Public()
  @Get('geo/cities')
  cities() {
    return this.finder.cities();
  }

  @Public()
  @Get('geo/cities/:cityId/districts')
  districts(@Param('cityId', ParseIntPipe) cityId: number) {
    return this.finder.districts(cityId);
  }
}
