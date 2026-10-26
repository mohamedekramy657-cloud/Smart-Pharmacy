import { Errors } from '../../common/errors';

/** Explicit, unit-tested state machines. Anything not listed is an invalid transition. */
export type PoStatus = 'DRAFT' | 'SUBMITTED' | 'CONFIRMED' | 'PARTIALLY_CONFIRMED' | 'REJECTED' | 'CANCELLED'
  | 'IN_FULFILLMENT' | 'PARTIALLY_DELIVERED' | 'DELIVERED' | 'CLOSED';
export type ShipmentStatus = 'DRAFT' | 'DISPATCHED' | 'IN_TRANSIT' | 'DELAYED' | 'ARRIVED' | 'DELIVERED' | 'PARTIALLY_DELIVERED' | 'CANCELLED';

export const PO_TRANSITIONS: Record<PoStatus, PoStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['CONFIRMED', 'PARTIALLY_CONFIRMED', 'REJECTED', 'CANCELLED'],
  CONFIRMED: ['IN_FULFILLMENT', 'CANCELLED'],
  PARTIALLY_CONFIRMED: ['IN_FULFILLMENT', 'CANCELLED'],
  IN_FULFILLMENT: ['PARTIALLY_DELIVERED', 'DELIVERED', 'CLOSED'],
  PARTIALLY_DELIVERED: ['DELIVERED', 'CLOSED'],
  DELIVERED: [],
  REJECTED: [],
  CANCELLED: [],
  CLOSED: [],
};

export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  DRAFT: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['IN_TRANSIT', 'DELAYED', 'ARRIVED', 'DELIVERED', 'PARTIALLY_DELIVERED'],
  IN_TRANSIT: ['DELAYED', 'ARRIVED', 'DELIVERED', 'PARTIALLY_DELIVERED'],
  DELAYED: ['IN_TRANSIT', 'ARRIVED', 'DELIVERED', 'PARTIALLY_DELIVERED'],
  ARRIVED: ['DELIVERED', 'PARTIALLY_DELIVERED'],
  DELIVERED: [],
  PARTIALLY_DELIVERED: [],
  CANCELLED: [],
};

/** Shipment statuses a warehouse may set manually (receipt outcomes are set only by the pharmacy). */
export const WAREHOUSE_SETTABLE: ShipmentStatus[] = ['IN_TRANSIT', 'DELAYED', 'ARRIVED'];
export const OPEN_SHIPMENT: ShipmentStatus[] = ['DRAFT', 'DISPATCHED', 'IN_TRANSIT', 'DELAYED', 'ARRIVED'];
export const RECEIVABLE: ShipmentStatus[] = ['DISPATCHED', 'IN_TRANSIT', 'DELAYED', 'ARRIVED'];

export function canTransition<S extends string>(machine: Record<S, S[]>, from: S, to: S): boolean {
  return machine[from]?.includes(to) ?? false;
}

export function assertTransition<S extends string>(machine: Record<S, S[]>, from: S, to: S, entity: string): void {
  if (!canTransition(machine, from, to)) {
    throw Errors.invalidState(`${entity} cannot move from ${from} to ${to}`, { from, to, allowed: machine[from] ?? [] });
  }
}

/** Patient/pharmacy-facing delivery date label, derived consistently everywhere. */
export function deliveryDateStatus(s: { status: string; estimatedDeliveryAt: Date | string | null; scheduleConfidence: string }, now = new Date()):
  'CONFIRMED' | 'ESTIMATED' | 'PENDING_CONFIRMATION' | 'DELAYED' | 'UNKNOWN' {
  const open = ['DRAFT', 'DISPATCHED', 'IN_TRANSIT', 'DELAYED', 'ARRIVED'].includes(s.status);
  if (s.status === 'DELAYED') return 'DELAYED';
  if (open && s.estimatedDeliveryAt && new Date(s.estimatedDeliveryAt) < now && s.status !== 'ARRIVED') return 'DELAYED';
  if (!s.estimatedDeliveryAt) return s.scheduleConfidence === 'PENDING_CONFIRMATION' ? 'PENDING_CONFIRMATION' : 'UNKNOWN';
  return s.scheduleConfidence as 'CONFIRMED' | 'ESTIMATED' | 'PENDING_CONFIRMATION' | 'UNKNOWN';
}
