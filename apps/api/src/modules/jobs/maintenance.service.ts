import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '../../common/settings.service';
import { Database } from '../../database/db';
import { IntegrationsService } from '../integrations/integrations.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AlertsService } from '../patient/alerts.service';
import { RequestsService } from '../patient/requests.service';
import { JobsService } from './jobs.service';

/** Registers job handlers and periodic maintenance tasks (executed only where the worker runs). */
@Injectable()
export class MaintenanceService implements OnModuleInit {
  private readonly logger = new Logger('Maintenance');

  constructor(
    private readonly db: Database,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly requests: RequestsService,
    private readonly alerts: AlertsService,
    private readonly integrations: IntegrationsService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register('inventory.lowStock', (p) => this.lowStock(String(p.itemId)));
    this.jobs.register('alerts.match', async (p) => { await this.alerts.matchItem(String(p.itemId)); });

    this.jobs.every('expire-holds-and-requests', 30_000, async () => {
      const r = await this.requests.expireDue();
      if (r.holds || r.requests) this.logger.log(r, 'expired holds/requests');
    });
    this.jobs.every('integration-health', 120_000, async () => { await this.integrations.evaluateHealth(); });
    this.jobs.every('overdue-shipments', 300_000, () => this.overdueShipments());
    this.jobs.every('expiring-batches', 6 * 3_600_000, () => this.expiringBatches());
    this.jobs.every('expire-alerts', 3_600_000, async () => {
      await this.db.exec(`UPDATE availability_alerts SET status = 'EXPIRED' WHERE status IN ('ACTIVE','PAUSED','TRIGGERED') AND expires_at <= now()`);
    });
    this.jobs.every('retention', 12 * 3_600_000, () => this.retention());
  }

  private async lowStock(itemId: string) {
    const item = await this.db.maybeOne<{ organizationId: string; medicine: string; availableQty: number; lowStockThreshold: number | null }>(
      `SELECT i.organization_id, m.brand_name_en || ' ' || m.strength AS medicine, i.available_qty, i.low_stock_threshold
         FROM inventory_items i JOIN medicines m ON m.id = i.medicine_id WHERE i.id = $1`, [itemId]);
    if (!item || item.lowStockThreshold === null || item.availableQty > item.lowStockThreshold) return; // recovered since enqueue
    await this.db.tx((tx) => this.notifications.toOrg(tx, item.organizationId, {
      type: 'LOW_STOCK', dedupeKey: `low-stock:${itemId}:${new Date().toISOString().slice(0, 10)}`,
      data: { medicine: item.medicine, available: item.availableQty, threshold: item.lowStockThreshold, itemId },
    }, ['ORG_OWNER', 'ORG_MANAGER', 'ORG_STAFF']));
  }

  private async overdueShipments() {
    const rows = await this.db.query<{ id: string; shipmentNumber: string; pharmacyOrgId: string; warehouseOrgId: string; estimatedDeliveryAt: Date }>(
      `SELECT id, shipment_number, pharmacy_org_id, warehouse_org_id, estimated_delivery_at FROM shipments
        WHERE status IN ('DISPATCHED','IN_TRANSIT','DELAYED') AND estimated_delivery_at < now() - interval '30 minutes' LIMIT 200`);
    for (const s of rows) {
      const n = { type: 'SHIPMENT_OVERDUE', dedupeKey: `overdue:${s.id}:${new Date(s.estimatedDeliveryAt).toISOString()}`, data: { shipmentNumber: s.shipmentNumber, eta: new Date(s.estimatedDeliveryAt).toISOString(), shipmentId: s.id } };
      await this.db.tx(async (tx) => {
        await this.notifications.toOrg(tx, s.pharmacyOrgId, n, ['ORG_OWNER', 'ORG_MANAGER']);
        await this.notifications.toOrg(tx, s.warehouseOrgId, n, ['ORG_OWNER', 'ORG_MANAGER']);
      });
    }
  }

  private async expiringBatches() {
    const days = await this.settings.get('inventory.expiryAlertDays');
    const rows = await this.db.query<{ id: string; organizationId: string; medicine: string; batchNumber: string; quantity: number; expiryDate: string }>(
      `SELECT b.id, i.organization_id, m.brand_name_en || ' ' || m.strength AS medicine, b.batch_number, b.quantity, b.expiry_date
         FROM inventory_batches b JOIN inventory_items i ON i.id = b.inventory_item_id JOIN medicines m ON m.id = i.medicine_id
        WHERE b.status = 'ACTIVE' AND b.quantity > 0 AND b.expiry_date <= current_date + $1::int LIMIT 500`, [days]);
    for (const b of rows) {
      await this.db.tx((tx) => this.notifications.toOrg(tx, b.organizationId, {
        type: 'BATCH_EXPIRING', dedupeKey: `batch-expiring:${b.id}`, data: { medicine: b.medicine, batch: b.batchNumber, qty: b.quantity, expiry: b.expiryDate },
      }, ['ORG_OWNER', 'ORG_MANAGER']));
    }
  }

  private async retention() {
    await this.db.exec(`DELETE FROM idempotency_records WHERE created_at < now() - interval '7 days'`);
    await this.db.exec(`DELETE FROM jobs WHERE status = 'SUCCEEDED' AND completed_at < now() - interval '14 days'`);
    await this.db.exec(`DELETE FROM sessions WHERE (revoked_at IS NOT NULL OR absolute_expires_at < now()) AND created_at < now() - interval '30 days'`);
    await this.db.exec(`DELETE FROM search_events WHERE occurred_at < now() - interval '365 days'`);
  }
}
