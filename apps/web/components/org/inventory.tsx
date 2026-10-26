'use client';

import { useState } from 'react';
import { MedicineOption, MedicinePicker } from '@/components/medicine-picker';
import { Alert, Badge, Button, Card, Field, inputCls, StateView, statusTone, Table, useAction, useLoad } from '@/components/ui';
import { api, newIdempotencyKey, qs } from '@/lib/api';
import { Membership, useAgo, useDateFmt } from '@/lib/providers';

export interface TabProps { orgId: string; org: Membership; can: (p: string) => boolean; L: (en: string, ar: string) => string }
interface Item { id: string; brandNameEn: string; strength: string; dosageForm: string; packageSize: number; packageUnit: string; physicalQty: number; reservedQty: number; unavailableQty: number; availableQty: number; lowStockThreshold: number | null; availabilityStatus: string; freshness: string; lastUpdatedAt: string; lastUpdateSource: string; version: number; isListed: boolean; medicineStatus: string }

const ADJUSTMENTS = ['STOCK_COUNT', 'SALE', 'RECEIVE_EXTERNAL', 'WRITE_OFF', 'MARK_UNAVAILABLE', 'RESTORE_AVAILABLE'] as const;

export function InventoryTab({ orgId, can, L }: TabProps) {
  const ago = useAgo();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Item | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const list = useLoad(() => api<{ items: Item[]; total: number }>(`/orgs/${orgId}/inventory?${qs({ q, filter, page, pageSize: 25 })}`), [orgId, q, filter, page]);
  const [barcode, setBarcode] = useState('');
  const [barcodeMsg, setBarcodeMsg] = useState<string | null>(null);

  const lookup = async () => {
    setBarcodeMsg(null);
    try {
      const r = await api<{ medicine: { brandNameEn: string; strength: string } | null; item: Item | null }>(`/orgs/${orgId}/inventory/barcode/${encodeURIComponent(barcode.trim())}`);
      if (r.item) setSelected(r.item);
      else setBarcodeMsg(r.medicine ? L(`${r.medicine.brandNameEn} ${r.medicine.strength} is in the catalog but not in your inventory — add it below.`, `${r.medicine.brandNameEn} موجود بالكتالوج وليس في مخزونك — أضفه أدناه.`) : L('Barcode not found in the central catalog.', 'الباركود غير موجود في الكتالوج.'));
    } catch (e) { setBarcodeMsg((e as Error).message); }
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={L('Search', 'بحث')}><input className={inputCls} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></Field>
          <Field label={L('Filter', 'تصفية')}>
            <select className={inputCls} value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }}>
              {['ALL', 'LOW_STOCK', 'OUT_OF_STOCK', 'STALE', 'UNLISTED'].map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </Field>
          <Field label={L('Barcode scan', 'مسح الباركود')}><input className={inputCls} inputMode="numeric" value={barcode} onChange={(e) => setBarcode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void lookup(); } }} placeholder="622…" /></Field>
          {can('inventory:write') && <Button onClick={() => setShowAdd((v) => !v)}>+ {L('Add product', 'إضافة منتج')}</Button>}
          {can('inventory:import') && <Button variant="secondary" onClick={() => setShowImport((v) => !v)}>{L('Import CSV', 'استيراد CSV')}</Button>}
        </div>
        {barcodeMsg && <div className="mt-2"><Alert tone="blue">{barcodeMsg}</Alert></div>}
      </Card>
      {showAdd && <AddItem orgId={orgId} L={L} onDone={() => { setShowAdd(false); void list.reload(); }} />}
      {showImport && <ImportCsv orgId={orgId} L={L} onDone={() => list.reload()} />}
      {selected && <ItemPanel orgId={orgId} itemId={selected.id} can={can} L={L} onClose={() => setSelected(null)} onChanged={() => list.reload()} />}
      <Card>
        <StateView state={list} empty={(d) => d.items.length === 0}>{(d) => (
          <>
            <Table head={[L('Product', 'المنتج'), L('Physical', 'فعلي'), L('Reserved', 'محجوز'), L('Unavailable', 'غير متاح'), L('Available', 'متاح'), L('Status', 'الحالة'), L('Updated', 'آخر تحديث'), '']}
              rows={d.items.map((i) => [
                <div key="p"><div className="font-medium">{i.brandNameEn} {i.strength}</div><div className="text-xs text-slate-500">{i.dosageForm.toLowerCase()} · {i.packageSize} {i.packageUnit.toLowerCase()}</div>{i.medicineStatus !== 'ACTIVE' && <Badge tone="red">{i.medicineStatus}</Badge>}</div>,
                i.physicalQty, i.reservedQty, i.unavailableQty, <strong key="a">{i.availableQty}</strong>,
                <Badge key="s" tone={statusTone(i.availabilityStatus)}>{i.availabilityStatus}</Badge>,
                <span key="u" className="text-xs">{ago(i.lastUpdatedAt)}<br />{i.lastUpdateSource}</span>,
                <Button key="b" variant="ghost" onClick={() => setSelected(i)}>{L('Manage', 'إدارة')}</Button>,
              ])} />
            <div className="mt-3 flex items-center gap-2 text-sm">
              <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</Button>
              <span>{page} / {Math.max(1, Math.ceil(d.total / 25))}</span>
              <Button variant="secondary" disabled={page * 25 >= d.total} onClick={() => setPage(page + 1)}>›</Button>
            </div>
          </>)}
        </StateView>
      </Card>
    </div>
  );
}

function AddItem({ orgId, L, onDone }: { orgId: string; L: TabProps['L']; onDone: () => void }) {
  const [med, setMed] = useState<MedicineOption | null>(null);
  const [qty, setQty] = useState(0);
  const [threshold, setThreshold] = useState('');
  const [key] = useState(newIdempotencyKey);
  const a = useAction();
  const submit = () => a.run(async () => {
    await api(`/orgs/${orgId}/inventory`, { body: { medicineId: med!.id, openingQty: qty, lowStockThreshold: threshold === '' ? undefined : Number(threshold) }, idempotencyKey: key });
    onDone();
  });
  return (
    <Card>
      <h3 className="mb-2 font-semibold">{L('Add product to inventory', 'إضافة منتج للمخزون')}</h3>
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem_8rem_auto] sm:items-end">
        <MedicinePicker value={med} onChange={setMed} />
        <Field label={L('Counted quantity', 'الكمية المعدودة')}><input type="number" min={0} className={inputCls} value={qty} onChange={(e) => setQty(Math.max(0, Number(e.target.value)))} /></Field>
        <Field label={L('Low-stock alert at', 'تنبيه عند')}><input type="number" min={0} className={inputCls} value={threshold} onChange={(e) => setThreshold(e.target.value)} /></Field>
        <Button disabled={!med || a.pending} onClick={submit}>{L('Add', 'إضافة')}</Button>
      </div>
      {a.error && <div className="mt-2"><Alert>{a.error}</Alert></div>}
    </Card>
  );
}

function ItemPanel({ orgId, itemId, can, L, onClose, onChanged }: { orgId: string; itemId: string; can: TabProps['can']; L: TabProps['L']; onClose: () => void; onChanged: () => void }) {
  const fmt = useDateFmt();
  const item = useLoad(() => api<Item & { batches: Array<{ id: string; batchNumber: string; expiryDate: string; quantity: number; status: string }> }>(`/orgs/${orgId}/inventory/${itemId}`), [itemId]);
  const moves = useLoad(() => api<Array<{ id: number; movementType: string; physicalDelta: number; reservedDelta: number; unavailableDelta: number; physicalAfter: number; reservedAfter: number; unavailableAfter: number; source: string; reasonCode: string | null; note: string | null; actorName: string | null; createdAt: string }>>(`/orgs/${orgId}/inventory/${itemId}/movements`), [itemId]);
  const [type, setType] = useState<(typeof ADJUSTMENTS)[number]>('STOCK_COUNT');
  const [qty, setQty] = useState(0);
  const [reason, setReason] = useState('DAMAGED');
  const [note, setNote] = useState('');
  const [key, setKey] = useState(newIdempotencyKey);
  const a = useAction();
  const refresh = async () => { await item.reload(); await moves.reload(); onChanged(); };
  const adjust = () => a.run(async () => {
    const body: Record<string, unknown> = type === 'STOCK_COUNT' ? { type, countedQty: qty } : { type, qty };
    if (type === 'WRITE_OFF' || type === 'MARK_UNAVAILABLE') body.reasonCode = reason;
    if (note) body.note = note;
    if (item.data) body.expectedVersion = item.data.version;
    await api(`/orgs/${orgId}/inventory/${itemId}/adjustments`, { body, idempotencyKey: key });
    setKey(newIdempotencyKey()); setNote('');
    await refresh();
  }, L('Saved', 'تم الحفظ'));

  return (
    <Card className="border-teal-300">
      <StateView state={item}>{(i) => (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="me-auto font-semibold">{i.brandNameEn} {i.strength}</h3>
            <Badge tone={statusTone(i.availabilityStatus)}>{i.availabilityStatus}</Badge>
            <Button variant="ghost" onClick={onClose}>✕</Button>
          </div>
          <p className="text-sm">{L('Physical', 'فعلي')} <b>{i.physicalQty}</b> − {L('Reserved', 'محجوز')} <b>{i.reservedQty}</b> − {L('Unavailable', 'غير متاح')} <b>{i.unavailableQty}</b> = {L('Available', 'متاح')} <b>{i.availableQty}</b></p>
          {can('inventory:write') && (
            <div className="grid gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-[12rem_7rem_10rem_1fr_auto] sm:items-end">
              <Field label={L('Change type', 'نوع التعديل')}><select className={inputCls} value={type} onChange={(e) => setType(e.target.value as typeof type)}>{ADJUSTMENTS.map((x) => <option key={x}>{x}</option>)}</select></Field>
              <Field label={type === 'STOCK_COUNT' ? L('Counted qty', 'العدد الفعلي') : L('Quantity', 'الكمية')}><input type="number" min={0} className={inputCls} value={qty} onChange={(e) => setQty(Math.max(0, Number(e.target.value)))} /></Field>
              {(type === 'WRITE_OFF' || type === 'MARK_UNAVAILABLE') ? <Field label={L('Reason', 'السبب')}><select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)}>{(type === 'WRITE_OFF' ? ['DAMAGED', 'EXPIRED', 'LOST', 'RECALLED'] : ['DAMAGED', 'EXPIRED', 'QUARANTINE', 'RECALLED']).map((r) => <option key={r}>{r}</option>)}</select></Field> : <span />}
              <Field label={L('Note', 'ملاحظة')}><input className={inputCls} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <div className="flex gap-2">
                <Button disabled={a.pending} onClick={adjust}>{L('Apply', 'تطبيق')}</Button>
                <Button variant="secondary" disabled={a.pending} onClick={() => a.run(async () => { await api(`/orgs/${orgId}/inventory/${itemId}/verify`, { method: 'POST', body: {} }); await refresh(); }, L('Marked as verified', 'تم التأكيد'))}>{L('Still accurate', 'ما زال صحيحًا')}</Button>
              </div>
            </div>
          )}
          {a.error && <Alert>{a.error}</Alert>}
          {a.ok && <Alert tone="green">{a.ok}</Alert>}
          {i.batches.length > 0 && <Table head={[L('Batch', 'التشغيلة'), L('Expiry', 'الصلاحية'), L('Qty', 'الكمية'), L('Status', 'الحالة')]} rows={i.batches.map((b) => [b.batchNumber, b.expiryDate, b.quantity, <Badge key="s" tone={statusTone(b.status)}>{b.status}</Badge>])} />}
          <h4 className="text-sm font-semibold">{L('Movement history (append-only ledger)', 'سجل الحركات')}</h4>
          <StateView state={moves} empty={(d) => d.length === 0}>{(rows) => (
            <Table head={[L('When', 'الوقت'), L('Type', 'النوع'), 'Δ phys / res / unav', L('After', 'بعد'), L('By', 'بواسطة')]}
              rows={rows.map((mv) => [fmt(mv.createdAt), <span key="t">{mv.movementType}{mv.reasonCode && <span className="text-xs text-slate-500"> · {mv.reasonCode}</span>}{mv.note && <span className="block text-xs text-slate-500">{mv.note}</span>}</span>,
                `${mv.physicalDelta} / ${mv.reservedDelta} / ${mv.unavailableDelta}`, `${mv.physicalAfter} / ${mv.reservedAfter} / ${mv.unavailableAfter}`, mv.actorName ?? mv.source])} />)}
          </StateView>
        </div>)}
      </StateView>
    </Card>
  );
}

function ImportCsv({ orgId, L, onDone }: { orgId: string; L: TabProps['L']; onDone: () => void }) {
  const [csv, setCsv] = useState('barcode,physical_qty,low_stock_threshold,batch_number,expiry_date\n');
  const [result, setResult] = useState<{ status: string; rowCount: number; validRows: number; errors: Array<{ line: number; errors: string[] }> } | null>(null);
  const a = useAction();
  const run = (mode: 'validate' | 'commit') => a.run(async () => {
    try {
      setResult(await api(`/orgs/${orgId}/inventory/imports`, { body: { csv, mode } }));
      if (mode === 'commit') onDone();
    } catch (e) {
      const d = (e as { details?: { errors?: Array<{ line: number; errors: string[] }>; rowCount?: number; validRows?: number } }).details;
      if (d?.errors) setResult({ status: 'REJECTED', rowCount: d.rowCount ?? 0, validRows: d.validRows ?? 0, errors: d.errors });
      throw e;
    }
  });
  return (
    <Card>
      <h3 className="font-semibold">{L('CSV stock import (counted quantities)', 'استيراد المخزون CSV')}</h3>
      <p className="text-xs text-slate-600">{L('physical_qty is the counted quantity (snapshot). Products are matched by barcode or medicine_id. Nothing is imported if any row has an error.', 'الكمية هي العدد الفعلي. لا يتم استيراد أي شيء إذا وُجد خطأ في أي سطر.')}</p>
      <input type="file" accept=".csv,text/csv" className="my-2 text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
      <textarea className={`${inputCls} h-32 font-mono`} value={csv} onChange={(e) => setCsv(e.target.value)} />
      <div className="mt-2 flex gap-2"><Button variant="secondary" disabled={a.pending} onClick={() => run('validate')}>{L('Validate', 'تحقق')}</Button><Button disabled={a.pending} onClick={() => run('commit')}>{L('Import', 'استيراد')}</Button></div>
      {result && <div className="mt-2 text-sm"><Badge tone={statusTone(result.status)}>{result.status}</Badge> {result.validRows}/{result.rowCount}
        {result.errors.length > 0 && <ul className="mt-1 list-disc ps-5 text-red-800">{result.errors.map((er) => <li key={er.line}>{L('Line', 'سطر')} {er.line}: {er.errors.join('; ')}</li>)}</ul>}</div>}
      {a.error && !result && <Alert>{a.error}</Alert>}
    </Card>
  );
}
