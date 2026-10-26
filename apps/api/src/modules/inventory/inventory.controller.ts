import { Controller, Get, Headers, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthContext, CurrentAuth, CurrentOrg, OrgAccess, OrgContext } from '../../common/auth/decorators';
import { UuidParam, ZBody, ZQuery } from '../../common/zod';
import { ImportSchema, ImportService } from './import.service';
import { AddItemSchema, AdjustmentSchema, BatchSchema, InventoryListSchema, InventoryService, ItemSettingsSchema, PriceSchema } from './inventory.service';

/** Inventory for the caller's own organization (pharmacy or warehouse). Tenant-scoped by :orgId. */
@ApiTags('inventory')
@Controller('v1/orgs/:orgId/inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService, private readonly imports: ImportService) {}

  @OrgAccess('inventory:read')
  @Get()
  list(@CurrentOrg() org: OrgContext, @ZQuery(InventoryListSchema) q: z.infer<typeof InventoryListSchema>) {
    return this.inventory.list(org.id, q);
  }

  @OrgAccess('inventory:read')
  @Get('barcode/:code')
  barcode(@CurrentOrg() org: OrgContext, @Param('code') code: string) {
    return this.inventory.barcodeLookup(org.id, code);
  }

  @OrgAccess('inventory:read')
  @Get('expiring')
  expiring(@CurrentOrg() org: OrgContext, @ZQuery(z.object({ days: z.coerce.number().int().min(1).max(365).default(60) })) q: { days: number }) {
    return this.inventory.expiringBatches(org.id, q.days);
  }

  @OrgAccess('inventory:read')
  @Get(':itemId')
  get(@CurrentOrg() org: OrgContext, @UuidParam('itemId') itemId: string) {
    return this.inventory.get(org.id, itemId);
  }

  @OrgAccess('inventory:read')
  @Get(':itemId/movements')
  movements(@CurrentOrg() org: OrgContext, @UuidParam('itemId') itemId: string, @ZQuery(z.object({ page: z.coerce.number().int().min(1).default(1) })) q: { page: number }) {
    return this.inventory.movements(org.id, itemId, q.page);
  }

  @OrgAccess('inventory:write')
  @Post()
  add(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @ZBody(AddItemSchema) body: z.infer<typeof AddItemSchema>, @Headers('idempotency-key') idem?: string) {
    return this.inventory.addItem(org.id, auth.user.id, body, idem);
  }

  @OrgAccess('inventory:write')
  @Post(':itemId/adjustments')
  adjust(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('itemId') itemId: string, @ZBody(AdjustmentSchema) body: z.infer<typeof AdjustmentSchema>, @Headers('idempotency-key') idem?: string) {
    return this.inventory.adjust(org.id, itemId, auth.user.id, body, idem);
  }

  @OrgAccess('inventory:write')
  @Post(':itemId/verify')
  @HttpCode(200)
  verify(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('itemId') itemId: string) {
    return this.inventory.verify(org.id, itemId, auth.user.id);
  }

  @OrgAccess('inventory:write')
  @Patch(':itemId')
  settings(@CurrentOrg() org: OrgContext, @UuidParam('itemId') itemId: string, @ZBody(ItemSettingsSchema) body: z.infer<typeof ItemSettingsSchema>) {
    return this.inventory.updateSettings(org.id, itemId, body);
  }

  @OrgAccess('inventory:price')
  @Put(':itemId/price')
  price(@CurrentOrg() org: OrgContext, @UuidParam('itemId') itemId: string, @ZBody(PriceSchema) body: z.infer<typeof PriceSchema>) {
    return this.inventory.setPrice(org.id, itemId, body.unitPrice);
  }

  @OrgAccess('inventory:write')
  @Put(':itemId/batches')
  batch(@CurrentOrg() org: OrgContext, @UuidParam('itemId') itemId: string, @ZBody(BatchSchema) body: z.infer<typeof BatchSchema>) {
    return this.inventory.upsertBatch(org.id, itemId, body);
  }

  @OrgAccess('inventory:import')
  @Post('imports')
  import(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @ZBody(ImportSchema) body: z.infer<typeof ImportSchema>) {
    return this.imports.run(org.id, auth.user.id, body);
  }
}
