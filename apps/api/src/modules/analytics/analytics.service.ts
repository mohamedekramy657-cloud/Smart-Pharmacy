import { Injectable } from '@nestjs/common';
import { SettingsService } from '../../common/settings.service';
import { Database } from '../../database/db';

const MIN_SAMPLE = 3; // metrics with fewer observations are reported as "insufficient data" (null)

/** Operational analytics computed only from recorded data, with sample sizes exposed. */
@Injectable()
export class AnalyticsService {
  constructor(private readonly db: Database, private readonly settings: SettingsService) {}

  async pharmacy(orgId: string) {
    const windows = await this.settings.get('freshness.bySource');
    const staleMinutes = windows.MANUAL.staleMinutes;
    const expiryDays = await this.settings.get('inventory.expiryAlertDays');
    const summary = await this.db.one(
      `SELECT count(*)::int AS products,
              count(*) FILTER (WHERE available_qty <= 0)::int AS out_of_stock,
              count(*) FILTER (WHERE low_stock_threshold IS NOT NULL AND available_qty > 0 AND available_qty <= low_stock_threshold)::int AS low_stock,
              count(*) FILTER (WHERE last_updated_at < now() - make_interval(mins => $2))::int AS stale,
              coalesce(sum(reserved_qty),0)::int AS reserved_units, coalesce(sum(unavailable_qty),0)::int AS unavailable_units,
              (SELECT count(*)::int FROM inventory_batches b JOIN inventory_items i2 ON i2.id = b.inventory_item_id
                WHERE i2.organization_id = $1 AND b.status = 'ACTIVE' AND b.quantity > 0 AND b.expiry_date <= current_date + $3::int) AS expiring_batches,
              (SELECT count(*)::int FROM purchase_orders WHERE pharmacy_org_id = $1 AND status IN ('SUBMITTED','CONFIRMED','PARTIALLY_CONFIRMED','IN_FULFILLMENT','PARTIALLY_DELIVERED')) AS open_orders,
              (SELECT count(*)::int FROM shipments WHERE pharmacy_org_id = $1 AND status IN ('DISPATCHED','IN_TRANSIT','DELAYED','ARRIVED')) AS incoming_shipments,
              (SELECT count(*)::int FROM shipments WHERE pharmacy_org_id = $1 AND status IN ('DISPATCHED','IN_TRANSIT','DELAYED') AND estimated_delivery_at < now()) AS overdue_shipments,
              (SELECT count(*)::int FROM stock_confirmation_requests WHERE pharmacy_org_id = $1 AND status = 'PENDING' AND expires_at > now()) AS pending_requests,
              (SELECT count(*)::int FROM stock_reservations WHERE organization_id = $1 AND status = 'ACTIVE') AS active_holds,
              (SELECT count(*)::int FROM delivery_discrepancies WHERE pharmacy_org_id = $1 AND status IN ('OPEN','ACKNOWLEDGED','DISPUTED')) AS open_discrepancies
         FROM inventory_items WHERE organization_id = $1`, [orgId, staleMinutes, expiryDays]);
    return { summary, suppliers: await this.supplierPerformance(orgId) };
  }

  /** Supplier comparison from completed records only (null = insufficient data, never guessed). */
  async supplierPerformance(pharmacyOrgId: string) {
    const rows = await this.db.query<Record<string, number | string | null>>(
      `WITH po AS (
         SELECT po.warehouse_org_id, po.status, sum(poi.requested_qty) AS requested, sum(coalesce(poi.confirmed_qty,0)) AS confirmed,
                sum(poi.received_qty) AS received, sum(poi.damaged_qty + poi.missing_qty) AS discrepancy_units, sum(poi.dispatched_qty) AS dispatched
           FROM purchase_orders po JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
          WHERE po.pharmacy_org_id = $1 AND po.status <> 'DRAFT' GROUP BY po.id, po.warehouse_org_id, po.status),
       sh AS (
         SELECT s.warehouse_org_id, count(*) AS received_shipments,
                count(*) FILTER (WHERE s.received_at <= coalesce(first_eta.eta, s.estimated_delivery_at)) AS on_time,
                count(*) FILTER (WHERE coalesce(first_eta.eta, s.estimated_delivery_at) IS NOT NULL) AS with_eta,
                avg(extract(epoch FROM (s.received_at - s.dispatched_at)) / 3600) AS avg_transit_hours
           FROM shipments s
           LEFT JOIN LATERAL (SELECT new_estimated_at AS eta FROM delivery_schedule_updates d WHERE d.shipment_id = s.id AND d.new_estimated_at IS NOT NULL ORDER BY d.id LIMIT 1) first_eta ON true
          WHERE s.pharmacy_org_id = $1 AND s.received_at IS NOT NULL GROUP BY s.warehouse_org_id)
       SELECT o.id AS warehouse_org_id, o.name_en AS warehouse_name,
              count(po.*)::int AS orders,
              count(*) FILTER (WHERE po.status = 'REJECTED')::int AS rejected,
              count(*) FILTER (WHERE po.status = 'CANCELLED')::int AS cancelled,
              sum(po.requested)::int AS requested_units, sum(po.confirmed)::int AS confirmed_units, sum(po.received)::int AS received_units,
              sum(po.dispatched)::int AS dispatched_units, sum(po.discrepancy_units)::int AS discrepancy_units,
              coalesce(max(sh.received_shipments),0)::int AS received_shipments, coalesce(max(sh.on_time),0)::int AS on_time_shipments,
              coalesce(max(sh.with_eta),0)::int AS shipments_with_eta, round(max(sh.avg_transit_hours)::numeric, 1)::float AS avg_transit_hours
         FROM po JOIN organizations o ON o.id = po.warehouse_org_id LEFT JOIN sh ON sh.warehouse_org_id = po.warehouse_org_id
        GROUP BY o.id, o.name_en ORDER BY o.name_en`, [pharmacyOrgId]);
    return rows.map((r) => {
      const ratio = (num: number, den: number, n: number) => (n >= MIN_SAMPLE && den > 0 ? Math.round((num / den) * 1000) / 10 : null);
      return {
        ...r,
        confirmationRatePct: ratio(Number(r.confirmedUnits), Number(r.requestedUnits), Number(r.orders)),
        onTimeRatePct: ratio(Number(r.onTimeShipments), Number(r.shipmentsWithEta), Number(r.shipmentsWithEta)),
        discrepancyRatePct: ratio(Number(r.discrepancyUnits), Number(r.dispatchedUnits), Number(r.receivedShipments)),
        avgTransitHours: Number(r.receivedShipments) >= MIN_SAMPLE ? r.avgTransitHours : null,
        sampleNote: `Rates require at least ${MIN_SAMPLE} completed observations`,
      };
    });
  }

  async warehouse(orgId: string) {
    return this.db.one(
      `SELECT (SELECT count(*)::int FROM purchase_orders WHERE warehouse_org_id = $1 AND status = 'SUBMITTED') AS orders_awaiting_decision,
              (SELECT count(*)::int FROM purchase_orders WHERE warehouse_org_id = $1 AND status IN ('CONFIRMED','PARTIALLY_CONFIRMED','IN_FULFILLMENT','PARTIALLY_DELIVERED')) AS orders_in_progress,
              (SELECT coalesce(sum(poi.allocated_qty),0)::int FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id WHERE po.warehouse_org_id = $1) AS allocated_units,
              (SELECT count(*)::int FROM shipments WHERE warehouse_org_id = $1 AND status = 'DRAFT') AS draft_shipments,
              (SELECT count(*)::int FROM shipments WHERE warehouse_org_id = $1 AND status IN ('DISPATCHED','IN_TRANSIT','ARRIVED')) AS shipments_in_transit,
              (SELECT count(*)::int FROM shipments WHERE warehouse_org_id = $1 AND (status = 'DELAYED' OR (status IN ('DISPATCHED','IN_TRANSIT') AND estimated_delivery_at < now()))) AS delayed_shipments,
              (SELECT count(*)::int FROM delivery_discrepancies WHERE warehouse_org_id = $1 AND status IN ('OPEN','ACKNOWLEDGED','DISPUTED')) AS open_discrepancies,
              (SELECT count(*)::int FROM supply_relationships WHERE warehouse_org_id = $1 AND status = 'ACTIVE') AS active_customers,
              (SELECT count(*)::int FROM supply_relationships WHERE warehouse_org_id = $1 AND status = 'PENDING') AS pending_customers,
              (SELECT count(*)::int FROM inventory_items WHERE organization_id = $1 AND low_stock_threshold IS NOT NULL AND available_qty <= low_stock_threshold) AS low_stock_products,
              (SELECT round(avg(extract(epoch FROM (decided_at - submitted_at)) / 3600)::numeric, 1)::float FROM purchase_orders WHERE warehouse_org_id = $1 AND decided_at IS NOT NULL) AS avg_hours_to_decision`,
      [orgId]);
  }

  async platform() {
    const outcomes = await this.db.query(`SELECT outcome, count(*)::int AS count, round(avg(latency_ms))::int AS avg_latency_ms FROM search_events WHERE occurred_at > now() - interval '7 days' GROUP BY outcome ORDER BY count DESC`);
    const unmet = await this.db.query(
      `SELECT e.medicine_id, m.brand_name_en, m.strength, m.dosage_form, count(*)::int AS searches
         FROM search_events e JOIN medicines m ON m.id = e.medicine_id
        WHERE e.occurred_at > now() - interval '30 days' AND e.outcome IN ('NO_MATCHING_STOCK','NO_VERIFIED_STOCK','INVENTORY_DATA_UNAVAILABLE','PARTIAL_QUANTITY_ONLY')
        GROUP BY e.medicine_id, m.brand_name_en, m.strength, m.dosage_form ORDER BY searches DESC LIMIT 20`);
    const latency = await this.db.one(
      `SELECT count(*)::int AS searches, percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::int AS p50_ms, percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95_ms
         FROM search_events WHERE occurred_at > now() - interval '7 days'`);
    return { outcomes, unmetDemand: unmet, latency };
  }
}
