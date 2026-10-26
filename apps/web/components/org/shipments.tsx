'use client';

import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, inputCls, StateView, statusTone, Table, useAction, useLoad } from '@/components/ui';
import { api, newIdempotencyKey } from '@/lib/api';
import { useAgo, useDateFmt } from '@/lib/providers';
import type { TabProps } from './inventory';

interface ShipRow { id: string; shipmentNumber: string; status: string; orderNumber: string; pharmacyName: string; warehouseName: string; estimatedDeliveryAt: string | null; scheduleConfidence: string; scheduleUpdatedAt: string | null; deliveryDateStatus: string; totalUnits: number; carrier: string | null; trackingNumber: string | null }
interface ShipDetail extends ShipRow { items: Array<{ id: string; brandNameEn: string; strength: string; quantity: number; batchNumber: string | null; expiryDate: string | null; receivedQty: number | null; damagedQty: number | null; missingQty: number | null }>; schedule: Array<{ newEstimatedAt: string | null; newConfidence: string; reason: string | null; isDelay: boolean; createdAt: string }>; discrepancies: Array<{ id: string; type: string; quantity: number; status: string }> }

export function ShipmentsTab(props: TabProps) {
  const { orgId, org, L } = props;
  const fmt = useDateFmt();
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useLoad(() => api<ShipRow[]>(`/orgs/${orgId}/shipments`), [orgId]);
  return (
    <div className="space-y-4">
      {openId && <ShipmentPanel {...props} id={openId} onClose={() => setOpenId(null)} onChanged={() => list.reload()} />}
      <Card>
        <StateView state={list} empty={(d) => d.length === 0}>{(rows) => (
          <Table head={[L('Shipment', 'الشحنة'), L('Order', 'الطلب'), org.type === 'PHARMACY' ? L('Warehouse', 'المخزن') : L('Pharmacy', 'الصيدلية'), L('Units', 'الوحدات'), L('Status', 'الحالة'), L('ETA', 'الموعد'), L('Date status', 'حالة الموعد'), '']}
            rows={rows.map((s) => [s.shipmentNumber, s.orderNumber, org.type === 'PHARMACY' ? s.warehouseName : s.pharmacyName, s.totalUnits, <Badge key="s" tone={statusTone(s.status)}>{s.status}</Badge>, fmt(s.estimatedDeliveryAt), <Badge key="d" tone={statusTone(s.deliveryDateStatus)}>{s.deliveryDateStatus}</Badge>, <Button key="o" variant="ghost" onClick={() => setOpenId(s.id)}>{L('Open', 'فتح')}</Button>])} />)}
        </StateView>
      </Card>
    </div>
  );
}

function ShipmentPanel({ orgId, org, can, L, id, onClose, onChanged }: TabProps & { id: string; onClose: () => void; onChanged: () => void }) {
  const fmt = useDateFmt();
  const s = useLoad(() => api<ShipDetail>(`/orgs/${orgId}/shipments/${id}`), [id]);
  const a = useAction();
  const [reason, setReason] = useState('');
  const [eta, setEta] = useState('');
  const [confidence, setConfidence] = useState('ESTIMATED');
  const [receipt, setReceipt] = useState<Record<string, { received: number; damaged: number }>>({});
  const [key, setKey] = useState(newIdempotencyKey);
  const act = (fn: () => Promise<unknown>, ok: string) => a.run(async () => { await fn(); setKey(newIdempotencyKey()); await s.reload(); onChanged(); }, ok);
  const isWh = org.type === 'WAREHOUSE';

  return (
    <Card className="border-teal-300">
      <StateView state={s}>{(d) => {
        const open = ['DISPATCHED', 'IN_TRANSIT', 'DELAYED', 'ARRIVED'].includes(d.status);
        return (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="me-auto font-semibold">{d.shipmentNumber} · {d.orderNumber}</h3>
              <Badge tone={statusTone(d.status)}>{d.status}</Badge><Badge tone={statusTone(d.deliveryDateStatus)}>{d.deliveryDateStatus}</Badge>
              <Button variant="ghost" onClick={onClose}>✕</Button>
            </div>
            <p className="text-sm">{L('ETA', 'الموعد')}: {fmt(d.estimatedDeliveryAt)} ({d.scheduleConfidence}) · {L('last schedule update', 'آخر تحديث للموعد')}: {fmt(d.scheduleUpdatedAt)}{d.carrier && ` · ${d.carrier}`}</p>
            <Table head={[L('Product', 'المنتج'), L('Shipped', 'المشحون'), L('Batch / expiry', 'التشغيلة / الصلاحية'), L('Received', 'مستلم'), L('Damaged', 'تالف'), L('Missing', 'ناقص')]}
              rows={d.items.map((i) => {
                const r = receipt[i.id] ?? { received: i.quantity, damaged: 0 };
                const editing = !isWh && open && can('supply:receive');
                return [`${i.brandNameEn} ${i.strength}`, i.quantity, `${i.batchNumber ?? '—'} ${i.expiryDate ?? ''}`,
                  editing ? <input key="r" type="number" min={0} max={i.quantity} className={`${inputCls} w-20`} value={r.received} onChange={(e) => setReceipt({ ...receipt, [i.id]: { ...r, received: Math.max(0, Math.min(i.quantity, Number(e.target.value))) } })} /> : (i.receivedQty ?? '—'),
                  editing ? <input key="d" type="number" min={0} max={i.quantity} className={`${inputCls} w-20`} value={r.damaged} onChange={(e) => setReceipt({ ...receipt, [i.id]: { ...r, damaged: Math.max(0, Math.min(i.quantity, Number(e.target.value))) } })} /> : (i.damagedQty ?? '—'),
                  editing ? <b key="m" className={i.quantity - r.received - r.damaged < 0 ? 'text-red-700' : ''}>{i.quantity - r.received - r.damaged}</b> : (i.missingQty ?? '—')];
              })} />
            {!isWh && open && can('supply:receive') && (
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="mb-2 text-xs text-slate-600">{L('Only received units are added to your stock. Damaged and missing units are recorded as discrepancies for the warehouse.', 'تُضاف الكميات المستلمة فقط إلى مخزونك. التالف والناقص يُسجل كفروقات.')}</p>
                <Button disabled={a.pending} onClick={() => act(() => api(`/orgs/${orgId}/shipments/${id}/receive`, { body: { items: d.items.map((i) => ({ shipmentItemId: i.id, receivedQty: (receipt[i.id] ?? { received: i.quantity }).received, damagedQty: (receipt[i.id] ?? { damaged: 0 }).damaged })) }, idempotencyKey: key }), L('Receipt recorded; stock updated', 'تم تسجيل الاستلام وتحديث المخزون'))}>{L('Confirm receipt', 'تأكيد الاستلام')}</Button>
              </div>
            )}
            {isWh && can('supply:fulfil') && (
              <div className="space-y-2 rounded-lg bg-slate-50 p-3">
                <div className="flex flex-wrap gap-2">
                  {d.status === 'DRAFT' && <Button disabled={a.pending} onClick={() => act(() => api(`/orgs/${orgId}/shipments/${id}/dispatch`, { method: 'POST', body: {}, idempotencyKey: key }), L('Dispatched', 'تم الشحن'))}>{L('Dispatch', 'شحن')}</Button>}
                  {['DISPATCHED', 'DELAYED'].includes(d.status) && <Button variant="secondary" onClick={() => act(() => api(`/orgs/${orgId}/shipments/${id}/status`, { body: { status: 'IN_TRANSIT' } }), 'OK')}>IN_TRANSIT</Button>}
                  {['DISPATCHED', 'IN_TRANSIT', 'DELAYED'].includes(d.status) && <Button variant="secondary" onClick={() => act(() => api(`/orgs/${orgId}/shipments/${id}/status`, { body: { status: 'ARRIVED' } }), 'OK')}>ARRIVED</Button>}
                  {['DISPATCHED', 'IN_TRANSIT'].includes(d.status) && <Button variant="danger" disabled={reason.length < 3} onClick={() => act(() => api(`/orgs/${orgId}/shipments/${id}/status`, { body: { status: 'DELAYED', reason } }), 'OK')}>DELAYED</Button>}
                  {d.status === 'DRAFT' && <Button variant="danger" disabled={reason.length < 3} onClick={() => act(() => api(`/orgs/${orgId}/shipments/${id}/cancel`, { body: { reason } }), 'OK')}>{L('Cancel', 'إلغاء')}</Button>}
                </div>
                {(d.status === 'DRAFT' || open) && (
                  <div className="grid gap-2 sm:grid-cols-4 sm:items-end">
                    <Field label={L('New ETA', 'موعد جديد')}><input type="datetime-local" className={inputCls} value={eta} onChange={(e) => setEta(e.target.value)} /></Field>
                    <Field label={L('Confidence', 'الدقة')}><select className={inputCls} value={confidence} onChange={(e) => setConfidence(e.target.value)}>{['CONFIRMED', 'ESTIMATED', 'PENDING_CONFIRMATION', 'UNKNOWN'].map((c) => <option key={c}>{c}</option>)}</select></Field>
                    <Field label={L('Reason (required for delays)', 'السبب')}><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                    <Button variant="secondary" onClick={() => act(() => api(`/orgs/${orgId}/shipments/${id}/schedule`, { body: { estimatedDeliveryAt: eta ? new Date(eta).toISOString() : null, confidence, reason: reason || undefined } }), L('Schedule updated; pharmacy notified', 'تم تحديث الموعد وإخطار الصيدلية'))}>{L('Update schedule', 'تحديث الموعد')}</Button>
                  </div>
                )}
              </div>
            )}
            {a.error && <Alert>{a.error}</Alert>}
            {a.ok && <Alert tone="green">{a.ok}</Alert>}
            {d.discrepancies.length > 0 && <p className="text-sm">{L('Discrepancies', 'الفروقات')}: {d.discrepancies.map((x) => `${x.type} ${x.quantity} (${x.status})`).join(', ')}</p>}
            <details><summary className="cursor-pointer text-sm font-medium">{L('Schedule history', 'سجل المواعيد')}</summary>
              <ul className="mt-2 space-y-1 text-xs">{d.schedule.map((h, idx) => <li key={idx}>{fmt(h.createdAt)} → {fmt(h.newEstimatedAt)} ({h.newConfidence}){h.isDelay && ' ⚠️'}{h.reason && ` · ${h.reason}`}</li>)}</ul>
            </details>
          </div>
        );
      }}</StateView>
    </Card>
  );
}

export function IncomingTab({ orgId, L }: TabProps) {
  const fmt = useDateFmt();
  const ago = useAgo();
  const rows = useLoad(() => api<Array<{ orderNumber: string; orderStatus: string; warehouseName: string; brandNameEn: string; strength: string; requestedQty: number; confirmedQty: number | null; allocatedQty: number; dispatchedQty: number; receivedQty: number; shipmentNumber: string | null; status: string | null; dispatchedAt: string | null; estimatedDeliveryAt: string | null; scheduleUpdatedAt: string | null; deliveryDateStatus: string; isOverdue: boolean; delayReason: string | null }>>(`/orgs/${orgId}/incoming`), [orgId]);
  return (
    <Card>
      <p className="mb-2 text-sm text-slate-600">{L('Incoming stock is NOT part of your available inventory until you receive and verify it.', 'الوارد المتوقع ليس جزءًا من مخزونك المتاح حتى تستلمه وتتحقق منه.')}</p>
      <StateView state={rows} empty={(d) => d.length === 0}>{(d) => (
        <Table head={[L('Warehouse', 'المخزن'), L('Order', 'الطلب'), L('Medicine', 'الدواء'), L('Req / Conf / Alloc', 'مطلوب/مؤكد/مخصص'), L('Dispatched', 'مشحون'), L('Received', 'مستلم'), L('Shipment', 'الشحنة'), L('ETA', 'الموعد'), L('Last schedule update', 'آخر تحديث')]}
          rows={d.map((r) => [r.warehouseName, <span key="o">{r.orderNumber}<br /><Badge tone={statusTone(r.orderStatus)}>{r.orderStatus}</Badge></span>, `${r.brandNameEn} ${r.strength}`, `${r.requestedQty} / ${r.confirmedQty ?? '—'} / ${r.allocatedQty}`, `${r.dispatchedQty}${r.dispatchedAt ? ` (${fmt(r.dispatchedAt)})` : ''}`, r.receivedQty,
            r.shipmentNumber ? <span key="s">{r.shipmentNumber}<br /><Badge tone={statusTone(r.status ?? '')}>{r.status}</Badge></span> : '—',
            <span key="e">{fmt(r.estimatedDeliveryAt)}<br /><Badge tone={statusTone(r.deliveryDateStatus)}>{r.deliveryDateStatus}</Badge>{r.isOverdue && <Badge tone="red">{L('Overdue', 'متأخر')}</Badge>}{r.delayReason && <span className="block text-xs">{r.delayReason}</span>}</span>,
            ago(r.scheduleUpdatedAt)])} />)}
      </StateView>
    </Card>
  );
}

export function DiscrepanciesTab({ orgId, org, can, L }: TabProps) {
  const fmt = useDateFmt();
  const list = useLoad(() => api<Array<{ id: string; type: string; quantity: number; status: string; resolution: string | null; note: string | null; resolutionNote: string | null; reportedAt: string; shipmentNumber: string; orderNumber: string; brandNameEn: string; strength: string; pharmacyName: string; warehouseName: string }>>(`/orgs/${orgId}/discrepancies`), [orgId]);
  const a = useAction();
  const [resolution, setResolution] = useState('CREDIT_ISSUED');
  const [note, setNote] = useState('');
  const act = (id: string, body: object) => a.run(async () => { await api(`/orgs/${orgId}/discrepancies/${id}`, { body }); await list.reload(); }, 'OK');
  const isWh = org.type === 'WAREHOUSE' && can('supply:discrepancy');
  return (
    <Card>
      {isWh && <div className="mb-3 grid gap-2 sm:grid-cols-2"><Field label={L('Resolution', 'طريقة الحل')}><select className={inputCls} value={resolution} onChange={(e) => setResolution(e.target.value)}>{['CREDIT_ISSUED', 'REPLACEMENT_PLANNED', 'WRITTEN_OFF', 'REJECTED'].map((r) => <option key={r}>{r}</option>)}</select></Field><Field label={L('Note', 'ملاحظة')}><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>}
      {a.error && <Alert>{a.error}</Alert>}
      <StateView state={list} empty={(d) => d.length === 0}>{(rows) => (
        <Table head={[L('Reported', 'التاريخ'), L('Shipment', 'الشحنة'), L('Medicine', 'الدواء'), L('Type', 'النوع'), L('Qty', 'الكمية'), L('Status', 'الحالة'), '']}
          rows={rows.map((d) => [fmt(d.reportedAt), `${d.shipmentNumber} · ${org.type === 'PHARMACY' ? d.warehouseName : d.pharmacyName}`, `${d.brandNameEn} ${d.strength}`, <Badge key="t" tone="red">{d.type}</Badge>, d.quantity,
            <span key="s"><Badge tone={statusTone(d.status)}>{d.status}</Badge>{d.resolution && <span className="block text-xs">{d.resolution}</span>}{d.resolutionNote && <span className="block text-xs">{d.resolutionNote}</span>}</span>,
            isWh && d.status !== 'RESOLVED' ? <div key="a" className="flex flex-wrap gap-1">
              {d.status === 'OPEN' && <Button variant="ghost" onClick={() => act(d.id, { action: 'ACKNOWLEDGE' })}>{L('Acknowledge', 'إقرار')}</Button>}
              <Button variant="ghost" onClick={() => act(d.id, { action: 'RESOLVE', resolution, note: note || undefined })}>{L('Resolve', 'حل')}</Button>
              {d.status !== 'DISPUTED' && <Button variant="ghost" onClick={() => act(d.id, { action: 'DISPUTE', note: note || undefined })}>{L('Dispute', 'اعتراض')}</Button>}
            </div> : null])} />)}
      </StateView>
    </Card>
  );
}
