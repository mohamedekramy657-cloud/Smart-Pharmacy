import { Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AuthContext, CurrentAuth, PlatformAdmin, Public } from '../../common/auth/decorators';
import { UuidParam, ZBody, ZQuery } from '../../common/zod';
import { CatalogSearchSchema, CatalogService, MedicineInputSchema } from './catalog.service';

const UpdateSchema = z.object({
  brandNameAr: z.string().trim().max(160).optional(), genericNameAr: z.string().trim().max(200).optional(), category: z.string().trim().max(80).optional(),
  registrationNumber: z.string().trim().max(64).optional(), barcode: z.string().regex(/^[0-9]{8,14}$/).optional(),
  imageUrl: z.url().startsWith('https://').optional(), imageLicense: z.string().trim().max(200).optional(), concentration: z.string().trim().max(80).optional(),
}).strict();
const StatusSchema = z.object({ status: z.enum(['ACTIVE', 'DISCONTINUED', 'RECALLED', 'SUSPENDED']), reason: z.string().trim().min(3).max(500) }).strict();
const AliasSchema = z.object({ alias: z.string().trim().min(2).max(120), language: z.enum(['ar', 'en', 'translit']) }).strict();
const AdminListSchema = z.object({ q: z.string().trim().max(100).optional(), status: z.string().max(20).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });

@ApiTags('catalog')
@Controller('v1/catalog/medicines')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get()
  search(@ZQuery(CatalogSearchSchema) q: z.infer<typeof CatalogSearchSchema>) {
    return this.catalog.search(q);
  }

  @Public()
  @Get(':id')
  get(@UuidParam('id') id: string) {
    return this.catalog.get(id);
  }
}

@ApiTags('admin')
@Controller('v1/admin/medicines')
export class AdminCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @PlatformAdmin()
  @Get()
  list(@ZQuery(AdminListSchema) q: z.infer<typeof AdminListSchema>) {
    return this.catalog.adminList(q.q, q.status, q.page, q.pageSize);
  }

  @PlatformAdmin()
  @Post()
  create(@ZBody(MedicineInputSchema) body: z.infer<typeof MedicineInputSchema>) {
    return this.catalog.create(body);
  }

  @PlatformAdmin()
  @Patch(':id')
  update(@UuidParam('id') id: string, @ZBody(UpdateSchema) body: z.infer<typeof UpdateSchema>) {
    return this.catalog.update(id, body);
  }

  @PlatformAdmin()
  @Post(':id/status')
  status(@UuidParam('id') id: string, @ZBody(StatusSchema) body: z.infer<typeof StatusSchema>, @CurrentAuth() auth: AuthContext) {
    return this.catalog.setStatus(id, body.status, body.reason, auth.user.id);
  }

  @PlatformAdmin()
  @Post(':id/aliases')
  addAlias(@UuidParam('id') id: string, @ZBody(AliasSchema) body: z.infer<typeof AliasSchema>) {
    return this.catalog.addAlias(id, body.alias, body.language);
  }

  @PlatformAdmin()
  @Delete(':id/aliases/:aliasId')
  async removeAlias(@UuidParam('id') id: string, @UuidParam('aliasId') aliasId: string) {
    await this.catalog.removeAlias(id, aliasId);
    return { ok: true };
  }
}
