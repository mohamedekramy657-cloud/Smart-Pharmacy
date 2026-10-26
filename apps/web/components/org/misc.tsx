'use client';

import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, inputCls, StateView, statusTone, Table, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { useAgo, useDateFmt } from '@/lib/providers';
import type { TabProps } from './inventory';

export function OverviewTab({ orgId, org, can, L }: TabProps) {
  const dash = useLoad(() => (can('analytics:read') ? api<Record<string, unknown>>(`/orgs/${orgId}/analytics/dashboard`) : Promise.resolve(null)), [orgId]);
  if (!can('analytics:read')) return <Card><p className="text-sm">{L('Use the tabs above to work with inventory, orders and shipments.', 'استخدم التبويبات أعلاه.')}</p></Card>;
  return (
    <StateView state={dash}>{(d) => {
      const summary = (org.type === 'PHARMACY' ? (d as { summary: Record<string, number> }).summary : d) as Record<string, number | null>;
      const suppliers = (d as { suppliers?: Array<Record<string, unknown>> }).suppliers ?? [];
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Object.entries(summary ?? {}).map(([k, v]) => (
              <Card key={k}><p className="text-xs text-slate-500">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</p><p className="text-2xl font-bold">{v ?? '—'}</p></Card>
            ))}
          </div>
          {org.type === 'PHARMACY' && (
            <Card>
              <h3 className="mb-2 font-semibold">{L('Supplier comparison (recorded data only)', 'مقارنة الموردين (بيانات مسجلة فقط)')}</h3>
              {suppliers.length === 0 ? <p className="text-sm text-slate-500">{L('No completed orders yet.', 'لا توجد طلبات مكتملة بعد.')}</p> : (
                <Table head={[L('Warehouse', 'المخزن'), L('Orders', 'الطلبات'), L('Confirmation %', 'نسبة التأكيد'), L('On-time %', 'الالتزام بالموعد'), L('Discrepancy %', 'نسبة الفروقات'), L('Avg transit (h)', 'متوسط النقل (س)')]}
                  rows={suppliers.map((s) => [String(s.warehouseName), String(s.orders), String(s.confirmationRatePct ?? L('insufficient data', 'بيانات غير كافية')), String(s.onTimeRatePct ?? L('insufficient data', 'بيانات غير كافية')), String(s.discrepancyRatePct ?? L('insufficient data', 'بيانات غير كافية')), String(s.avgTransitHours ?? '—')])} />
              )}
            </Card>
          )}
        </div>
      );
    }}</StateView>
  );
}

export function RequestsTab({ orgId, can, L }: TabProps) {
  const fmt = useDateFmt();
  const reqs = useLoad(() => api<Array<{ id: string; referenceCode: string; status: string; requestedQty: number; wantsHold: boolean; brandNameEn: string; strength: string; availableQty: number | null; expiresAt: string; createdAt: string }>>(`/orgs/${orgId}/confirmation-requests`), [orgId]);
  const holds = useLoad(() => api<Array<{ id: string; quantity: number; expiresAt: string; brandNameEn: string; strength: string; referenceCode: string | null }>>(`/orgs/${orgId}/holds`), [orgId]);
  const a = useAction();
  const [minutes, setMinutes] = useState(60);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const refresh = async () => { await reqs.reload(); await holds.reload(); };
  const respond = (id: string, outcome: string) => a.run(async () => { await api(`/orgs/${orgId}/confirmation-requests/${id}/respond`, { body: { outcome, holdMinutes: outcome === 'HOLD' ? minutes : undefined } }); await refresh(); }, L('Reply sent to patient', 'تم إرسال الرد للمريض'));
  const write = can('requests:respond');
  return (
    <div className="space-y-4">
      {a.error && <Alert>{a.error}</Alert>}
      {a.ok && <Alert tone="green">{a.ok}</Alert>}
      <Card>
        <div className="mb-2 flex flex-wrap items-end gap-2"><h3 className="me-auto font-semibold">{L('Confirmation requests', 'طلبات التأكيد')}</h3>
          <Field label={L('Hold duration (min)', 'مدة الحجز (دقيقة)')}><input type="number" min={10} max={240} className={`${inputCls} w-28`} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></Field></div>
        <StateView state={reqs} empty={(d) => d.length === 0}>{(rows) => (
          <Table head={[L('Ref', 'المرجع'), L('Medicine', 'الدواء'), L('Qty', 'الكمية'), L('Your stock', 'مخزونك'), L('Status', 'الحالة'), L('Expires', 'ينتهي'), '']}
            rows={rows.map((r) => [r.referenceCode, `${r.brandNameEn} ${r.strength}`, `${r.requestedQty}${r.wantsHold ? ` (${L('hold', 'حجز')})` : ''}`, r.availableQty ?? '—', <Badge key="s" tone={statusTone(r.status)}>{r.status}</Badge>, fmt(r.expiresAt),
              write && r.status === 'PENDING' ? <div key="a" className="flex flex-wrap gap-1">
                <Button variant="secondary" disabled={a.pending} onClick={() => respond(r.id, 'CONFIRMED_AVAILABLE')}>{L('Available', 'متوفر')}</Button>
                <Button variant="secondary" disabled={a.pending} onClick={() => respond(r.id, 'NOT_AVAILABLE')}>{L('Not available', 'غير متوفر')}</Button>
                {r.wantsHold && <Button disabled={a.pending} onClick={() => respond(r.id, 'HOLD')}>{L('Hold', 'احجز')}</Button>}
              </div> : null])} />)}
        </StateView>
      </Card>
      <Card>
        <h3 className="mb-2 font-semibold">{L('Active holds', 'الحجوزات النشطة')}</h3>
        <StateView state={holds} empty={(d) => d.length === 0}>{(rows) => (
          <Table head={[L('Ref', 'المرجع'), L('Medicine', 'الدواء'), L('Qty', 'الكمية'), L('Expires', 'ينتهي'), '']}
            rows={rows.map((h) => [h.referenceCode ?? '—', `${h.brandNameEn} ${h.strength}`, h.quantity, fmt(h.expiresAt), write ? <div key="a" className="flex flex-wrap gap-1">
              <input placeholder={L('pickup code', 'رمز الاستلام')} className={`${inputCls} w-28`} value={codes[h.id] ?? ''} onChange={(e) => setCodes({ ...codes, [h.id]: e.target.value })} />
              <Button variant="secondary" disabled={!codes[h.id]} onClick={() => a.run(async () => { await api(`/orgs/${orgId}/holds/${h.id}/fulfill`, { body: { pickupCode: codes[h.id] } }); await refresh(); }, L('Handed over', 'تم التسليم'))}>{L('Picked up', 'تم الاستلام')}</Button>
              <Button variant="ghost" onClick={() => a.run(async () => { await api(`/orgs/${orgId}/holds/${h.id}/release`, { method: 'POST', body: {} }); await refresh(); }, L('Released', 'تم الإلغاء'))}>{L('Release', 'إلغاء الحجز')}</Button>
            </div> : null])} />)}
        </StateView>
      </Card>
    </div>
  );
}

export function RelationshipsTab({ orgId, org, can, L }: TabProps) {
  const rels = useLoad(() => api<Array<{ id: string; status: string; counterpartyName: string; counterpartyPhone: string | null; paymentTerms: string | null; createdAt: string }>>(`/orgs/${orgId}/relationships`), [orgId]);
  const dir = useLoad(() => (org.type === 'PHARMACY' ? api<Array<{ id: string; nameEn: string; cityNameEn: string | null; servesMyCity: boolean; relationshipStatus: string | null; defaultLeadTimeHours: number; coldChainCapable: boolean }>>(`/orgs/${orgId}/warehouses`) : Promise.resolve([])), [orgId]);
  const a = useAction();
  const decide = (id: string, status: string) => a.run(async () => { await api(`/orgs/${orgId}/relationships/${id}`, { method: 'PATCH', body: { status } }); await rels.reload(); }, 'OK');
  return (
    <div className="space-y-4">
      {a.error && <Alert>{a.error}</Alert>}
      <Card>
        <h3 className="mb-2 font-semibold">{org.type === 'PHARMACY' ? L('My suppliers', 'الموردون') : L('Pharmacy customers', 'الصيدليات العملاء')}</h3>
        <StateView state={rels} empty={(d) => d.length === 0}>{(rows) => (
          <Table head={[L('Organization', 'المنشأة'), L('Phone', 'الهاتف'), L('Status', 'الحالة'), L('Terms', 'الشروط'), '']}
            rows={rows.map((r) => [r.counterpartyName, r.counterpartyPhone ?? '—', <Badge key="s" tone={statusTone(r.status)}>{r.status}</Badge>, r.paymentTerms ?? '—',
              org.type === 'WAREHOUSE' && can('supply:fulfil') ? <div key="a" className="flex gap-1">
                {r.status !== 'ACTIVE' && r.status !== 'TERMINATED' && <Button variant="secondary" onClick={() => decide(r.id, 'ACTIVE')}>{L('Approve', 'موافقة')}</Button>}
                {r.status === 'ACTIVE' && <Button variant="ghost" onClick={() => decide(r.id, 'SUSPENDED')}>{L('Suspend', 'إيقاف')}</Button>}
                {r.status !== 'TERMINATED' && <Button variant="ghost" onClick={() => decide(r.id, 'TERMINATED')}>{L('End', 'إنهاء')}</Button>}
              </div> : null])} />)}
        </StateView>
      </Card>
      {org.type === 'PHARMACY' && (
        <Card>
          <h3 className="mb-2 font-semibold">{L('Verified warehouses', 'المخازن الموثقة')}</h3>
          <StateView state={dir} empty={(d) => d.length === 0}>{(rows) => (
            <Table head={[L('Warehouse', 'المخزن'), L('City', 'المدينة'), L('Lead time', 'مدة التوريد'), '']}
              rows={rows.map((w) => [<span key="n">{w.nameEn}{w.servesMyCity && <Badge tone="green">{L('serves your city', 'يخدم مدينتك')}</Badge>}{w.coldChainCapable && <Badge tone="blue">cold chain</Badge>}</span>, w.cityNameEn ?? '—', `${w.defaultLeadTimeHours} h`,
                w.relationshipStatus ? <Badge key="s" tone={statusTone(w.relationshipStatus)}>{w.relationshipStatus}</Badge> : can('supply:order') ? <Button key="r" variant="secondary" disabled={a.pending} onClick={() => a.run(async () => { await api(`/orgs/${orgId}/relationships`, { body: { warehouseOrgId: w.id } }); await rels.reload(); await dir.reload(); }, 'OK')}>{L('Request supply', 'طلب توريد')}</Button> : null])} />)}
          </StateView>
        </Card>
      )}
    </div>
  );
}

export function IntegrationsTab({ orgId, L }: TabProps) {
  const ago = useAgo();
  const list = useLoad(() => api<Array<{ id: string; displayName: string; status: string; health: string; secretLast4: string; lastSuccessAt: string | null; consecutiveFailures: number; lastError: string | null; linkedItems: number }>>(`/orgs/${orgId}/integrations`), [orgId]);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<{ secret: string; webhookPath?: string } | null>(null);
  const a = useAction();
  return (
    <div className="space-y-4">
      <Card>
        <h3 className="mb-2 font-semibold">{L('Inventory webhook integrations', 'تكاملات المخزون')}</h3>
        <p className="mb-2 text-xs text-slate-600">{L('Your POS/ERP posts signed stock snapshots. Duplicate events are ignored; failing integrations are never shown to patients as confirmed stock.', 'يرسل نظامك لقطات مخزون موقعة. الأحداث المكررة تُتجاهل.')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={L('Name', 'الاسم')}><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Button disabled={name.length < 2 || a.pending} onClick={() => a.run(async () => { setSecret(await api(`/orgs/${orgId}/integrations`, { body: { displayName: name } })); await list.reload(); })}>{L('Create', 'إنشاء')}</Button>
        </div>
        {secret && <div className="mt-2"><Alert tone="amber">{L('Copy this secret now — it will not be shown again:', 'انسخ هذا السر الآن — لن يظهر مرة أخرى:')} <code className="break-all">{secret.secret}</code>{secret.webhookPath && <><br />POST {secret.webhookPath}</>}</Alert></div>}
        {a.error && <Alert>{a.error}</Alert>}
      </Card>
      <Card>
        <StateView state={list} empty={(d) => d.length === 0}>{(rows) => (
          <Table head={[L('Name', 'الاسم'), L('Status', 'الحالة'), L('Health', 'السلامة'), L('Last success', 'آخر نجاح'), L('Failures', 'الإخفاقات'), L('Items', 'المنتجات'), '']}
            rows={rows.map((c) => [<span key="n">{c.displayName}<span className="block text-xs text-slate-500">…{c.secretLast4}</span></span>, <Badge key="s" tone={statusTone(c.status)}>{c.status}</Badge>, <Badge key="h" tone={statusTone(c.health)}>{c.health}</Badge>, ago(c.lastSuccessAt), `${c.consecutiveFailures}${c.lastError ? ` · ${c.lastError}` : ''}`, c.linkedItems,
              <div key="a" className="flex gap-1">
                <Button variant="ghost" onClick={() => a.run(async () => { await api(`/orgs/${orgId}/integrations/${c.id}`, { method: 'PATCH', body: { status: c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' } }); await list.reload(); })}>{c.status === 'ACTIVE' ? L('Pause', 'إيقاف') : L('Activate', 'تفعيل')}</Button>
                <Button variant="ghost" onClick={() => a.run(async () => { setSecret(await api(`/orgs/${orgId}/integrations/${c.id}/rotate-secret`, { method: 'POST', body: {} })); })}>{L('Rotate secret', 'تغيير السر')}</Button>
              </div>])} />)}
        </StateView>
      </Card>
    </div>
  );
}

export function TeamTab({ orgId, can, L }: TabProps) {
  const members = useLoad(() => api<Array<{ userId: string; email: string; fullName: string; role: string }>>(`/orgs/${orgId}/members`), [orgId]);
  const [form, setForm] = useState({ email: '', role: 'ORG_STAFF', fullName: '', initialPassword: '' });
  const a = useAction();
  const manage = can('members:manage');
  return (
    <div className="space-y-4">
      {manage && (
        <Card>
          <h3 className="mb-2 font-semibold">{L('Add team member', 'إضافة عضو')}</h3>
          <div className="grid gap-2 sm:grid-cols-5 sm:items-end">
            <Field label="Email"><input className={inputCls} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label={L('Role', 'الدور')}><select className={inputCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{['ORG_MANAGER', 'ORG_STAFF', 'ORG_VIEWER', 'ORG_OWNER'].map((r) => <option key={r}>{r}</option>)}</select></Field>
            <Field label={L('Name (new accounts)', 'الاسم (حساب جديد)')}><input className={inputCls} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></Field>
            <Field label={L('Initial password (new accounts)', 'كلمة مرور مبدئية')}><input type="password" className={inputCls} value={form.initialPassword} onChange={(e) => setForm({ ...form, initialPassword: e.target.value })} /></Field>
            <Button disabled={a.pending} onClick={() => a.run(async () => { await api(`/orgs/${orgId}/members`, { body: { email: form.email, role: form.role, fullName: form.fullName || undefined, initialPassword: form.initialPassword || undefined } }); await members.reload(); }, 'OK')}>{L('Add', 'إضافة')}</Button>
          </div>
          {a.error && <div className="mt-2"><Alert>{a.error}</Alert></div>}
        </Card>
      )}
      <Card>
        <StateView state={members} empty={(d) => d.length === 0}>{(rows) => (
          <Table head={[L('Name', 'الاسم'), 'Email', L('Role', 'الدور'), '']}
            rows={rows.map((m) => [m.fullName, m.email, <Badge key="r">{m.role}</Badge>, manage ? <div key="a" className="flex gap-1">
              <select aria-label="role" className={`${inputCls} w-36`} defaultValue={m.role} onChange={(e) => a.run(async () => { await api(`/orgs/${orgId}/members/${m.userId}`, { method: 'PATCH', body: { role: e.target.value } }); await members.reload(); })}>{['ORG_OWNER', 'ORG_MANAGER', 'ORG_STAFF', 'ORG_VIEWER'].map((r) => <option key={r}>{r}</option>)}</select>
              <Button variant="ghost" onClick={() => a.run(async () => { await api(`/orgs/${orgId}/members/${m.userId}`, { method: 'PATCH', body: { role: 'REMOVE' } }); await members.reload(); })}>{L('Remove', 'إزالة')}</Button>
            </div> : null])} />)}
        </StateView>
      </Card>
    </div>
  );
}
