import { Controller, Get, Headers, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthContext, CurrentAuth, CurrentOrg, OrgAccess, OrgContext } from '../../common/auth/decorators';
import { UuidParam, ZBody, ZQuery } from '../../common/zod';
import { ConfirmPoSchema, CreatePoSchema, PoListSchema, PurchaseOrdersService, ReasonSchema } from './purchase-orders.service';
import { RelationshipDecisionSchema, RelationshipRequestSchema, RelationshipsService } from './relationships.service';
import { CreateShipmentSchema, DiscrepancyActionSchema, ReceiveSchema, ScheduleSchema, ShipmentsService, ShipmentStatusSchema } from './shipments.service';

const StatusFilter = z.object({ status: z.string().max(40).optional() });

/**
 * Supply chain endpoints. Access is double-checked: the guard verifies membership/permission for
 * :orgId, and every service query is scoped to records where the org is buyer or seller.
 */
@ApiTags('supply')
@Controller('v1/orgs/:orgId')
export class SupplyController {
  constructor(private readonly orders: PurchaseOrdersService, private readonly shipments: ShipmentsService, private readonly rels: RelationshipsService) {}

  // ---- relationships & warehouse directory ----
  @OrgAccess('supply:read', { orgType: 'PHARMACY' })
  @Get('warehouses')
  directory(@CurrentOrg() org: OrgContext) {
    return this.rels.directory(org);
  }

  @OrgAccess('supply:read', { orgType: 'PHARMACY', requireVerified: true })
  @Get('warehouses/:warehouseId/products')
  warehouseProducts(@CurrentOrg() org: OrgContext, @UuidParam('warehouseId') warehouseId: string, @ZQuery(z.object({ q: z.string().max(100).optional() })) q: { q?: string }) {
    return this.rels.warehouseProducts(org, warehouseId, q.q);
  }

  @OrgAccess('supply:read')
  @Get('relationships')
  relationships(@CurrentOrg() org: OrgContext) {
    return this.rels.list(org);
  }

  @OrgAccess('supply:order', { orgType: 'PHARMACY', requireVerified: true })
  @Post('relationships')
  requestRelationship(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @ZBody(RelationshipRequestSchema) body: z.infer<typeof RelationshipRequestSchema>) {
    return this.rels.request(org, auth.user.id, body);
  }

  @OrgAccess('supply:fulfil', { orgType: 'WAREHOUSE', requireVerified: true })
  @Patch('relationships/:relationshipId')
  decideRelationship(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('relationshipId') id: string, @ZBody(RelationshipDecisionSchema) body: z.infer<typeof RelationshipDecisionSchema>) {
    return this.rels.decide(org, auth.user.id, id, body);
  }

  // ---- purchase orders ----
  @OrgAccess('supply:read')
  @Get('purchase-orders')
  listOrders(@CurrentOrg() org: OrgContext, @ZQuery(PoListSchema) q: z.infer<typeof PoListSchema>) {
    return this.orders.list(org, q);
  }

  @OrgAccess('supply:read')
  @Get('purchase-orders/:poId')
  getOrder(@CurrentOrg() org: OrgContext, @UuidParam('poId') poId: string) {
    return this.orders.get(org, poId);
  }

  @OrgAccess('supply:order', { orgType: 'PHARMACY', requireVerified: true })
  @Post('purchase-orders')
  createOrder(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @ZBody(CreatePoSchema) body: z.infer<typeof CreatePoSchema>, @Headers('idempotency-key') idem?: string) {
    return this.orders.create(org, auth.user.id, body, idem);
  }

  @OrgAccess('supply:order', { orgType: 'PHARMACY', requireVerified: true })
  @Post('purchase-orders/:poId/submit')
  @HttpCode(200)
  submitOrder(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('poId') poId: string) {
    return this.orders.submit(org, auth.user.id, poId);
  }

  @OrgAccess('supply:fulfil', { orgType: 'WAREHOUSE', requireVerified: true })
  @Post('purchase-orders/:poId/confirm')
  @HttpCode(200)
  confirmOrder(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('poId') poId: string, @ZBody(ConfirmPoSchema) body: z.infer<typeof ConfirmPoSchema>, @Headers('idempotency-key') idem?: string) {
    return this.orders.confirm(org, auth.user.id, poId, body, idem);
  }

  @OrgAccess('supply:fulfil', { orgType: 'WAREHOUSE', requireVerified: true })
  @Post('purchase-orders/:poId/reject')
  @HttpCode(200)
  rejectOrder(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('poId') poId: string, @ZBody(ReasonSchema) body: z.infer<typeof ReasonSchema>) {
    return this.orders.reject(org, auth.user.id, poId, body.reason);
  }

  @OrgAccess('supply:order', { requireVerified: true })
  @Post('purchase-orders/:poId/cancel')
  @HttpCode(200)
  cancelOrder(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('poId') poId: string, @ZBody(ReasonSchema) body: z.infer<typeof ReasonSchema>) {
    return this.orders.cancel(org, auth.user.id, poId, body.reason);
  }

  @OrgAccess('supply:order', { requireVerified: true })
  @Post('purchase-orders/:poId/close')
  @HttpCode(200)
  closeOrder(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('poId') poId: string, @ZBody(ReasonSchema) body: z.infer<typeof ReasonSchema>) {
    return this.orders.close(org, auth.user.id, poId, body.reason);
  }

  // ---- shipments ----
  @OrgAccess('supply:read', { orgType: 'PHARMACY' })
  @Get('incoming')
  incoming(@CurrentOrg() org: OrgContext) {
    return this.shipments.incoming(org);
  }

  @OrgAccess('supply:read')
  @Get('shipments')
  listShipments(@CurrentOrg() org: OrgContext, @ZQuery(StatusFilter) q: { status?: string }) {
    return this.shipments.list(org, q.status);
  }

  @OrgAccess('supply:read')
  @Get('shipments/:shipmentId')
  getShipment(@CurrentOrg() org: OrgContext, @UuidParam('shipmentId') id: string) {
    return this.shipments.get(org, id);
  }

  @OrgAccess('supply:fulfil', { orgType: 'WAREHOUSE', requireVerified: true })
  @Post('shipments')
  createShipment(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @ZBody(CreateShipmentSchema) body: z.infer<typeof CreateShipmentSchema>, @Headers('idempotency-key') idem?: string) {
    return this.shipments.create(org, auth.user.id, body, idem);
  }

  @OrgAccess('supply:fulfil', { orgType: 'WAREHOUSE', requireVerified: true })
  @Post('shipments/:shipmentId/dispatch')
  @HttpCode(200)
  dispatch(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('shipmentId') id: string, @Headers('idempotency-key') idem?: string) {
    return this.shipments.dispatch(org, auth.user.id, id, idem);
  }

  @OrgAccess('supply:fulfil', { orgType: 'WAREHOUSE', requireVerified: true })
  @Post('shipments/:shipmentId/status')
  @HttpCode(200)
  status(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('shipmentId') id: string, @ZBody(ShipmentStatusSchema) body: z.infer<typeof ShipmentStatusSchema>) {
    return this.shipments.updateStatus(org, auth.user.id, id, body);
  }

  @OrgAccess('supply:fulfil', { orgType: 'WAREHOUSE', requireVerified: true })
  @Post('shipments/:shipmentId/schedule')
  @HttpCode(200)
  schedule(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('shipmentId') id: string, @ZBody(ScheduleSchema) body: z.infer<typeof ScheduleSchema>) {
    return this.shipments.updateSchedule(org, auth.user.id, id, body);
  }

  @OrgAccess('supply:fulfil', { orgType: 'WAREHOUSE', requireVerified: true })
  @Post('shipments/:shipmentId/cancel')
  @HttpCode(200)
  cancelShipment(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('shipmentId') id: string, @ZBody(ReasonSchema) body: z.infer<typeof ReasonSchema>) {
    return this.shipments.cancel(org, auth.user.id, id, body.reason);
  }

  @OrgAccess('supply:receive', { orgType: 'PHARMACY', requireVerified: true })
  @Post('shipments/:shipmentId/receive')
  @HttpCode(200)
  receive(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('shipmentId') id: string, @ZBody(ReceiveSchema) body: z.infer<typeof ReceiveSchema>, @Headers('idempotency-key') idem?: string) {
    return this.shipments.receive(org, auth.user.id, id, body, idem);
  }

  // ---- discrepancies ----
  @OrgAccess('supply:read')
  @Get('discrepancies')
  discrepancies(@CurrentOrg() org: OrgContext, @ZQuery(StatusFilter) q: { status?: string }) {
    return this.shipments.discrepancies(org, q.status);
  }

  @OrgAccess('supply:discrepancy', { orgType: 'WAREHOUSE', requireVerified: true })
  @Post('discrepancies/:discrepancyId')
  @HttpCode(200)
  actOnDiscrepancy(@CurrentOrg() org: OrgContext, @CurrentAuth() auth: AuthContext, @UuidParam('discrepancyId') id: string, @ZBody(DiscrepancyActionSchema) body: z.infer<typeof DiscrepancyActionSchema>) {
    return this.shipments.actOnDiscrepancy(org, auth.user.id, id, body);
  }
}
