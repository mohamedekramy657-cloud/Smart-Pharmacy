'use client';

import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, inputCls, StateView, statusTone, Table, useAction, useLoad } from '@/components/ui';
import { api, newIdempotencyKey, qs } from '@/lib/api';
import { useDateFmt } from '@/lib/providers';
import type { TabProps } from './inventory';

interface PoRow { id: string; orderNumber: string; status: string; pharmacyName: string; warehouseName: string; lineCount: number; totalRequested: number; createdAt: string; nextEta: string | null }
interface PoLine { id: string; medicineId: string; brandNameEn: string; strength: string; dosageForm: string; requestedQty: number; confirmedQty: number | null; allocatedQty: number; dispatchedQty: number; receivedQty: number; damagedQty: number; missingQty: number }
interface PoDetail { id: string; orderNumber: string; status: string; viewerRole: 'BUYER' | 'SELLER'; pharmacyName: string; warehouseName: string; notes: string | null; decisionNote: string | null; cancellationReason: string | null; items: PoLine[]; shipments: Array<{ id: string; shipmentNumber: string; status: string; estimatedDeliveryAt: string | null; deliveryDateStatus: string }>; history: Array<{ fromStatus: string | null; toStatus: string; note: string | null; createdAt: string; actorName: string | null }> }

export function OrdersTab(props: TabProps) {
  const { orgId, org, can, L } = props;
  const fmt = useDateFmt();
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useLoad(() => api<{ items: PoRow[] }>(`/orgs/${orgId}/purchase-orders?${qs({ status, pageSize: 50 })}`), [orgId, status]);
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={L('Status', 'الحالة')}><select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">—</option>{['DRAFT', 'SUBMITTED', 'CONFIRMED', 'PARTIALLY_CONFIRMED', 'IN_FULFILLMENT', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CLOSED', 'REJECTED', 'CANCELLED'].map((s) => <option key={s}>{s}</option>)}</select></Field>
          {org.type === 'PHARMACY' && can('supply:order') && <Button onClick={() => setCreating((v) => !v)}>+ {L('New purchase order', 'أمر شراء جديد')}</Button>}
        </div>
      </Card>
      {creating && <NewOrder {...props} onCreated={(id) => { setCreating(false); setOpenId(id); void list.reload(); }} />}
      {openId && <OrderDetail {...props} poId={openId} onClose={() => setOpenId(null)} onChanged={() => list.reload()} />}
      <Card>
        <StateView state={list} empty={(d) => d.items.length === 0}>{(d) => (
          <Table head={[L('Order', 'الطلب'), org.type === 'PHARMACY' ? L('Warehouse', 'المخزن') : L('Pharmacy', 'الصيدلية'), L('Lines', 'البنود'), L('Units', 'الوحدات'), L('Status', 'الحالة'), L('Next ETA', 'الموعد التالي'), L('Created', 'تاريخ الإنشاء'), '']}
            rows={d.items.map((p) => [p.orderNumber, org.type === 'PHARMACY' ? p.warehouseName : p.pharmacyName, p.lineCount, p.totalRequested, <Badge key="s" tone={statusTone(p.status)}>{p.status}</Badge>, fmt(p.nextEta), fmt(p.createdAt), <Button key="o" variant="ghost" onClick={() => setOpenId(p.id)}>{L('Open', 'فتح')}</Button>])} />)}
        </StateView>
      </Card>
    </div>
  );
}

function NewOrder({ orgId, L, onCreated }: TabProps & { onCreated: (id: string) => void }) {
  const rels = useLoad(() => api<Array<{ counterpartyId: string; counterpartyName: string; status: string }>>(`/orgs/${orgId}/relationships`), [orgId]);
  const [warehouseId, setWarehouseId] = useState('');
  const [q, setQ] = useState('');
  const products = useLoad(() => (warehouseId ? api<Array<{ medicineId: string; brandNameEn: string; strength: string; dosageForm: string; packageSize: number; packageUnit: string; availability: string }>>(`/orgs/${orgId}/warehouses/${warehouseId}/products?${qs({ q })}`) : Promise.resolve([])), [warehouseId, q]);
  const [lines, setLines] = useState<Record<string, { label: string; qty: number }>>({});
  const [notes, setNotes] = useState('');
  const [key] = useState(newIdempotencyKey);
  const a = useAction();
  const submit = (submitNow: boolean) => a.run(async () => {
    const po = await api<{ id: string }>(`/orgs/${orgId}/purchase-orders`, { body: { warehouseOrgId: warehouseId, items: Object.entries(lines).map(([medicineId, l]) => ({ medicineId, quantity: l.qty })), notes: notes || undefined, submit: submitNow }, idempotencyKey: key });
    onCreated(po.id);
  });
  return (
    <Card>
      <h3 className="mb-2 font-semibold">{L('New purchase order', 'أمر شراء جديد')}</h3>
      <StateView state={rels}>{(rs) => {
        const active = rs.filter((r) => r.status === 'ACTIVE');
        if (!active.length) return <Alert tone="amber">{L('No active supplier relationship yet. Request one in the Suppliers tab.', 'لا يوجد مورد نشط. اطلب علاقة توريد من تبويب الموردين.')}</Alert>;
        return (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label={L('Warehouse', 'المخزن')}><select className={inputCls} value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setLines({}); }}><option value="">—</option>{active.map((r) => <option key={r.counterpartyId} value={r.counterpartyId}>{r.counterpartyName}</option>)}</select></Field>
              {warehouseId && <Field label={L('Search products', 'بحث المنتجات')}><input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} /></Field>}
            </div>
            {warehouseId && <StateView state={products} empty={(d) => d.length === 0}>{(ps) => (
              <Table head={[L('Product', 'المنتج'), L('Availability', 'التوفر'), L('Quantity', 'الكمية')]} rows={ps.map((p) => [
                `${p.brandNameEn} ${p.strength} · ${p.dosageForm.toLowerCase()} · ${p.packageSize} ${p.packageUnit.toLowerCase()}`,
                <Badge key="a" tone={statusTone(p.availability === 'IN_STOCK' ? 'AVAILABLE' : p.availability)}>{p.availability}</Badge>,
                <input key="q" type="number" min={0} max={100000} className={`${inputCls} w-28`} value={lines[p.medicineId]?.qty ?? ''} placeholder="0"
                  onChange={(e) => { const n = Math.max(0, Number(e.target.value)); setLines((cur) => { const next = { ...cur }; if (n > 0) next[p.medicineId] = { label: `${p.brandNameEn} ${p.strength}`, qty: n }; else delete next[p.medicineId]; return next; }); }} />,
              ])} />)}
            </StateView>}
            <Field label={L('Notes', 'ملاحظات')}><input className={inputCls} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <p className="text-sm">{Object.values(lines).map((l) => `${l.label} × ${l.qty}`).join(' · ') || '—'}</p>
            <div className="flex gap-2">
              <Button disabled={!Object.keys(lines).length || a.pending} onClick={() => submit(true)}>{L('Submit order', 'إرسال الطلب')}</Button>
              <Button variant="secondary" disabled={!Object.keys(lines).length || a.pending} onClick={() => submit(false)}>{L('Save draft', 'حفظ كمسودة')}</Button>
            </div>
            {a.error && <Alert>{a.error}</Alert>}
          </div>
        );
      }}</StateView>
    </Card>
  );
}

function OrderDetail({ orgId, can, L, poId, onClose, onChanged }: TabProps & { poId: string; onClose: () => void; onChanged: () => void }) {
  const fmt = useDateFmt();
  const po = useLoad(() => api<PoDetail>(`/orgs/${orgId}/purchase-orders/${poId}`), [poId]);
  const a = useAction();
  const [reason, setReason] = useState('');
  const [confirmQty, setConfirmQty] = useState<Record<string, number>>({});
  const [ship, setShip] = useState<Record<string, { qty: number; batch: string; expiry: string }>>({});
  const line = (id: string) => ship[id] ?? { qty: 0, batch: '', expiry: '' };
  const [eta, setEta] = useState('');
  const [confidence, setConfidence] = useState('ESTIMATED');
  const [carrier, setCarrier] = useState('');
  const [key, setKey] = useState(newIdempotencyKey);
  const act = (fn: () => Promise<unknown>, ok: string) => a.run(async () => { await fn(); setKey(newIdempotencyKey()); await po.reload(); onChanged(); }, ok);

  return (
    <Card className="border-teal-300">
      <StateView state={po}>{(p) => {
        const seller = p.viewerRole === 'SELLER';
        const preDispatch = ['DRAFT', 'SUBMITTED', 'CONFIRMED', 'PARTIALLY_CONFIRMED'].includes(p.status);
        return (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="me-auto font-semibold">{p.orderNumber} · {seller ? p.pharmacyName : p.warehouseName}</h3>
              <Badge tone={statusTone(p.status)}>{p.status}</Badge>
              <Button variant="ghost" onClick={onClose}>✕</Button>
            </div>
            {p.notes && <p className="text-sm">📝 {p.notes}</p>}
            {(p.decisionNote || p.cancellationReason) && <p className="text-sm text-slate-600">{p.decisionNote ?? p.cancellationReason}</p>}
            <Table head={[L('Product', 'المنتج'), L('Requested', 'مطلوب'), L('Confirmed', 'مؤكد'), L('Allocated', 'مخصص'), L('Dispatched', 'مشحون'), L('Received', 'مستلم'), L('Damaged', 'تالف'), L('Missing', 'ناقص'), ...(seller && p.status === 'SUBMITTED' ? [L('Confirm qty', 'الكمية المؤكدة')] : []), ...(seller && ['CONFIRMED', 'PARTIALLY_CONFIRMED', 'IN_FULFILLMENT', 'PARTIALLY_DELIVERED'].includes(p.status) ? [L('Ship now', 'شحن الآن')] : [])]}
              rows={p.items.map((i) => [
                `${i.brandNameEn} ${i.strength}`, i.requestedQty, i.confirmedQty ?? '—', i.allocatedQty, i.dispatchedQty, i.receivedQty, i.damagedQty, i.missingQty,
                ...(seller && p.status === 'SUBMITTED' ? [<input key="c" type="number" min={0} max={i.requestedQty} className={`${inputCls} w-24`} value={confirmQty[i.id] ?? i.requestedQty} onChange={(e) => setConfirmQty({ ...confirmQty, [i.id]: Math.max(0, Math.min(i.requestedQty, Number(e.target.value))) })} />] : []),
                ...(seller && ['CONFIRMED', 'PARTIALLY_CONFIRMED', 'IN_FULFILLMENT', 'PARTIALLY_DELIVERED'].includes(p.status) ? [i.allocatedQty > 0 ? (
                  <div key="s" className="flex flex-wrap gap-1">
                    <input type="number" min={0} max={i.allocatedQty} placeholder="qty" className={`${inputCls} w-20`} value={ship[i.id]?.qty ?? ''} onChange={(e) => setShip({ ...ship, [i.id]: { ...line(i.id), qty: Math.max(0, Math.min(i.allocatedQty, Number(e.target.value))) } })} />
                    <input placeholder={L('batch', 'تشغيلة')} className={`${inputCls} w-24`} value={ship[i.id]?.batch ?? ''} onChange={(e) => setShip({ ...ship, [i.id]: { ...line(i.id), batch: e.target.value } })} />
                    <input type="date" className={`${inputCls} w-36`} value={ship[i.id]?.expiry ?? ''} onChange={(e) => setShip({ ...ship, [i.id]: { ...line(i.id), expiry: e.target.value } })} />
                  </div>) : '—'] : []),
              ])} />
            {seller && p.status === 'SUBMITTED' && can('supply:fulfil') && (
              <div className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3">
                <Button disabled={a.pending} onClick={() => act(() => api(`/orgs/${orgId}/purchase-orders/${poId}/confirm`, { body: { items: p.items.map((i) => ({ itemId: i.id, confirmedQty: confirmQty[i.id] ?? i.requestedQty })) }, idempotencyKey: key }), L('Order confirmed and stock allocated', 'تم التأكيد وتخصيص المخزون'))}>{L('Confirm & allocate', 'تأكيد وتخصيص')}</Button>
                <Field label={L('Rejection reason', 'سبب الرفض')}><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                <Button variant="danger" disabled={a.pending || reason.length < 3} onClick={() => act(() => api(`/orgs/${orgId}/purchase-orders/${poId}/reject`, { body: { reason } }), L('Rejected', 'تم الرفض'))}>{L('Reject', 'رفض')}</Button>
              </div>
            )}
            {seller && Object.values(ship).some((s) => s.qty > 0) && can('supply:fulfil') && (
              <div className="grid gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-4 sm:items-end">
                <Field label={L('Estimated delivery', 'موعد التسليم المتوقع')}><input type="datetime-local" className={inputCls} value={eta} onChange={(e) => setEta(e.target.value)} /></Field>
                <Field label={L('Date confidence', 'دقة الموعد')}><select className={inputCls} value={confidence} onChange={(e) => setConfidence(e.target.value)}>{['CONFIRMED', 'ESTIMATED', 'PENDING_CONFIRMATION', 'UNKNOWN'].map((c) => <option key={c}>{c}</option>)}</select></Field>
                <Field label={L('Carrier / tracking', 'الناقل / التتبع')}><input className={inputCls} value={carrier} onChange={(e) => setCarrier(e.target.value)} /></Field>
                <Button disabled={a.pending} onClick={() => act(() => api(`/orgs/${orgId}/shipments`, { body: {
                  purchaseOrderId: poId, items: Object.entries(ship).filter(([, s]) => s.qty > 0).map(([id, s]) => ({ purchaseOrderItemId: id, quantity: s.qty, batchNumber: s.batch || undefined, expiryDate: s.expiry || undefined })),
                  estimatedDeliveryAt: eta ? new Date(eta).toISOString() : undefined, scheduleConfidence: confidence, carrier: carrier || undefined }, idempotencyKey: key }).then(() => setShip({})), L('Shipment created (draft). Dispatch it from the Shipments tab.', 'تم إنشاء الشحنة كمسودة. أرسلها من تبويب الشحنات.'))}>{L('Create shipment', 'إنشاء شحنة')}</Button>
              </div>
            )}
            {(can('supply:order') || can('supply:fulfil')) && (
              <div className="flex flex-wrap items-end gap-2">
                {!seller && p.status === 'DRAFT' && <Button onClick={() => act(() => api(`/orgs/${orgId}/purchase-orders/${poId}/submit`, { method: 'POST', body: {} }), L('Submitted', 'تم الإرسال'))}>{L('Submit', 'إرسال')}</Button>}
                {(preDispatch || ['IN_FULFILLMENT', 'PARTIALLY_DELIVERED'].includes(p.status)) && <Field label={L('Reason', 'السبب')}><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
                {preDispatch && <Button variant="danger" disabled={reason.length < 3 || a.pending} onClick={() => act(() => api(`/orgs/${orgId}/purchase-orders/${poId}/cancel`, { body: { reason } }), L('Cancelled; allocations released', 'تم الإلغاء وتحرير المخصص'))}>{L('Cancel order', 'إلغاء الطلب')}</Button>}
                {['IN_FULFILLMENT', 'PARTIALLY_DELIVERED'].includes(p.status) && <Button variant="secondary" disabled={reason.length < 3 || a.pending} onClick={() => act(() => api(`/orgs/${orgId}/purchase-orders/${poId}/close`, { body: { reason } }), L('Closed', 'تم الإغلاق'))}>{L('Close (finish short)', 'إغلاق الطلب')}</Button>}
              </div>
            )}
            {a.error && <Alert>{a.error}</Alert>}
            {a.ok && <Alert tone="green">{a.ok}</Alert>}
            {p.shipments.length > 0 && <Table head={[L('Shipment', 'الشحنة'), L('Status', 'الحالة'), L('ETA', 'الموعد'), L('Date status', 'حالة الموعد')]} rows={p.shipments.map((s) => [s.shipmentNumber, <Badge key="s" tone={statusTone(s.status)}>{s.status}</Badge>, fmt(s.estimatedDeliveryAt), <Badge key="d" tone={statusTone(s.deliveryDateStatus)}>{s.deliveryDateStatus}</Badge>])} />}
            <details><summary className="cursor-pointer text-sm font-medium">{L('Status history', 'سجل الحالات')}</summary>
              <ul className="mt-2 space-y-1 text-xs">{p.history.map((h, idx) => <li key={idx}>{fmt(h.createdAt)} · {h.fromStatus ?? '∅'} → <b>{h.toStatus}</b>{h.actorName && ` · ${h.actorName}`}{h.note && ` · ${h.note}`}</li>)}</ul>
            </details>
          </div>
        );
      }}</StateView>
    </Card>
  );
}
