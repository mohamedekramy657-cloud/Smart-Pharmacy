'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, inputCls, StateView, statusTone, Table, Tabs, useAction, useLoad } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { useDateFmt, useI18n, useSession } from '@/lib/providers';

type Tab = 'overview' | 'verify' | 'orgs' | 'catalog' | 'settings' | 'jobs' | 'audit' | 'security' | 'integrations' | 'analytics';

export default function AdminPage() {
  const { t, locale } = useI18n();
  const { user, loading } = useSession();
  const [tab, setTab] = useState<Tab>('overview');
  const L = (en: string, ar: string) => (locale === 'ar' ? ar : en);
  if (loading) return <p>{t('loading')}</p>;
  if (user?.platformRole !== 'SUPER_ADMIN') return <Alert><Link className="underline" href="/login?next=/admin">{L('Administrator access required', 'يتطلب صلاحية مدير')}</Link></Alert>;
  const tabs: Array<[Tab, string]> = [['overview', L('Overview', 'نظرة عامة')], ['verify', L('Verifications', 'التوثيق')], ['orgs', L('Organizations', 'المنشآت')], ['catalog', L('Catalog', 'الكتالوج')], ['settings', L('Settings', 'الإعدادات')], ['jobs', L('Jobs', 'المهام')], ['audit', L('Audit log', 'سجل التدقيق')], ['security', L('Security', 'الأمان')], ['integrations', L('Integrations', 'التكاملات')], ['analytics', L('Search analytics', 'تحليلات البحث')]];
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">{L('Platform administration', 'إدارة المنصة')}</h1>
      {!user.mfaEnabled && <Alert tone="amber">{L('Enable multi-factor authentication for your administrator account (Security tab).', 'فعّل المصادقة متعددة العوامل لحسابك (تبويب الأمان).')}</Alert>}
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === 'overview' && <Overview L={L} />}
      {tab === 'verify' && <Verifications L={L} />}
      {tab === 'orgs' && <Organizations L={L} />}
      {tab === 'catalog' && <Catalog L={L} />}
      {tab === 'settings' && <SettingsTab L={L} />}
      {tab === 'jobs' && <Jobs L={L} />}
      {tab === 'audit' && <Audit L={L} />}
      {tab === 'security' && <Security L={L} />}
      {tab === 'integrations' && <IntegrationsHealth L={L} />}
      {tab === 'analytics' && <Analytics L={L} />}
    </div>
  );
}
type P = { L: (en: string, ar: string) => string };

function Overview({ L }: P) {
  const o = useLoad(() => api<Record<string, number>>('/admin/overview'), []);
  const [ledger, setLedger] = useState<{ ok: boolean; mismatches: unknown[]; negativeAvailable: number; checkedAt: string } | null>(null);
  const a = useAction();
  return (
    <div className="space-y-4">
      <StateView state={o}>{(d) => <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{Object.entries(d).map(([k, v]) => <Card key={k}><p className="text-xs text-slate-500">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</p><p className="text-2xl font-bold">{v}</p></Card>)}</div>}</StateView>
      <Card>
        <Button variant="secondary" disabled={a.pending} onClick={() => a.run(async () => setLedger(await api('/admin/ledger-check')))}>{L('Run inventory ledger reconciliation', 'تشغيل مطابقة سجل المخزون')}</Button>
        {ledger && <div className="mt-2"><Alert tone={ledger.ok ? 'green' : 'red'}>{ledger.ok ? L('All balances match the movement ledger; no negative availability.', 'كل الأرصدة مطابقة للسجل.') : `${ledger.mismatches.length} mismatches, ${ledger.negativeAvailable} negative`} ({ledger.checkedAt})</Alert></div>}
        {a.error && <Alert>{a.error}</Alert>}
      </Card>
    </div>
  );
}

function Verifications({ L }: P) {
  const q = useLoad(() => api<Array<{ organizationId: string; type: string; nameEn: string; nameAr: string | null; licenseNumber: string; registrationNumber: string | null; addressLine: string; phone: string; lat: number; lng: number; cityNameEn: string | null; submittedByEmail: string; submissionNotes: string | null; submittedAt: string }>>('/admin/verifications'), []);
  const [notes, setNotes] = useState('');
  const a = useAction();
  const fmt = useDateFmt();
  const decide = (id: string, decision: string) => a.run(async () => { await api(`/admin/organizations/${id}/verification`, { body: { decision, notes: notes || undefined } }); await q.reload(); }, 'OK');
  return (
    <Card>
      <p className="mb-2 text-xs text-slate-600">{L('Verify the license, registration and the exact location against official documents before approving. Approval makes a pharmacy visible to patients.', 'تحقق من الترخيص والموقع قبل الموافقة.')}</p>
      <Field label={L('Decision notes (required to reject)', 'ملاحظات القرار')}><input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      {a.error && <Alert>{a.error}</Alert>}
      <StateView state={q} empty={(d) => d.length === 0}>{(rows) => (
        <Table head={[L('Organization', 'المنشأة'), L('License', 'الترخيص'), L('Address / location', 'العنوان / الموقع'), L('Submitted', 'مقدم'), '']}
          rows={rows.map((r) => [<span key="n"><b>{r.nameEn}</b> {r.nameAr}<br /><Badge tone="blue">{r.type}</Badge></span>, `${r.licenseNumber}${r.registrationNumber ? ` / ${r.registrationNumber}` : ''}`,
            <span key="a">{r.addressLine}, {r.cityNameEn ?? ''}<br /><a className="text-xs text-teal-800 underline" target="_blank" rel="noopener noreferrer" href={`https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=17/${r.lat}/${r.lng}`}>{r.lat.toFixed(5)}, {r.lng.toFixed(5)}</a> · {r.phone}</span>,
            <span key="s">{r.submittedByEmail}<br />{fmt(r.submittedAt)}{r.submissionNotes && <><br />{r.submissionNotes}</>}</span>,
            <div key="b" className="flex gap-1"><Button onClick={() => decide(r.organizationId, 'VERIFIED')}>{L('Approve', 'اعتماد')}</Button><Button variant="danger" disabled={notes.length < 3} onClick={() => decide(r.organizationId, 'REJECTED')}>{L('Reject', 'رفض')}</Button></div>])} />)}
      </StateView>
    </Card>
  );
}

function Organizations({ L }: P) {
  const [f, setF] = useState({ type: '', verificationStatus: '', status: '', q: '' });
  const list = useLoad(() => api<{ items: Array<{ id: string; type: string; nameEn: string; verificationStatus: string; status: string; cityNameEn: string | null; memberCount: number; isDemo: boolean }> }>(`/admin/organizations?${qs({ ...f, pageSize: 100 })}`), [f.type, f.verificationStatus, f.status, f.q]);
  const [reason, setReason] = useState('');
  const a = useAction();
  const setStatus = (id: string, status: string) => a.run(async () => { await api(`/admin/organizations/${id}/status`, { body: { status, reason } }); await list.reload(); }, 'OK');
  return (
    <Card>
      <div className="mb-3 grid gap-2 sm:grid-cols-5">
        <input aria-label="search" placeholder={L('Search', 'بحث')} className={inputCls} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select aria-label="type" className={inputCls} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">type</option><option>PHARMACY</option><option>WAREHOUSE</option></select>
        <select aria-label="verification" className={inputCls} value={f.verificationStatus} onChange={(e) => setF({ ...f, verificationStatus: e.target.value })}><option value="">verification</option><option>PENDING</option><option>VERIFIED</option><option>REJECTED</option></select>
        <select aria-label="status" className={inputCls} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">status</option><option>ACTIVE</option><option>SUSPENDED</option><option>DEACTIVATED</option></select>
        <input aria-label="reason" placeholder={L('Reason for status change', 'سبب تغيير الحالة')} className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {a.error && <Alert>{a.error}</Alert>}
      <StateView state={list} empty={(d) => d.items.length === 0}>{(d) => (
        <Table head={[L('Name', 'الاسم'), L('Type', 'النوع'), L('City', 'المدينة'), L('Verification', 'التوثيق'), L('Status', 'الحالة'), L('Members', 'الأعضاء'), '']}
          rows={d.items.map((o) => [<span key="n">{o.nameEn}{o.isDemo && <Badge tone="amber">DEMO</Badge>}</span>, o.type, o.cityNameEn ?? '—', <Badge key="v" tone={statusTone(o.verificationStatus)}>{o.verificationStatus}</Badge>, <Badge key="s" tone={statusTone(o.status)}>{o.status}</Badge>, o.memberCount,
            o.status === 'ACTIVE' ? <Button key="b" variant="danger" disabled={reason.length < 3} onClick={() => setStatus(o.id, 'SUSPENDED')}>{L('Suspend', 'إيقاف')}</Button> : <Button key="b" variant="secondary" disabled={reason.length < 3} onClick={() => setStatus(o.id, 'ACTIVE')}>{L('Reactivate', 'إعادة تفعيل')}</Button>])} />)}
      </StateView>
    </Card>
  );
}

const FORMS = ['TABLET', 'FILM_COATED_TABLET', 'EFFERVESCENT_TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'ORAL_DROPS', 'INJECTION', 'CREAM', 'OINTMENT', 'GEL', 'EYE_DROPS', 'INHALER', 'SUPPOSITORY', 'SACHET', 'OTHER'];
const ROUTES = ['ORAL', 'TOPICAL', 'INTRAVENOUS', 'INTRAMUSCULAR', 'SUBCUTANEOUS', 'OPHTHALMIC', 'INHALATION', 'RECTAL', 'OTHER'];
const UNITS = ['TABLET', 'CAPSULE', 'ML', 'G', 'AMPOULE', 'VIAL', 'SACHET', 'SUPPOSITORY', 'DOSE', 'UNIT'];

function Catalog({ L }: P) {
  const [q, setQ] = useState('');
  const list = useLoad(() => api<{ items: Array<{ id: string; brandNameEn: string; brandNameAr: string | null; strength: string; dosageForm: string; packageSize: number; packageUnit: string; manufacturer: string; status: string; dataSource: string; barcode: string | null }> }>(`/admin/medicines?${qs({ q, pageSize: 50 })}`), [q]);
  const [m, setM] = useState({ brandNameEn: '', brandNameAr: '', genericNameEn: '', strength: '', dosageForm: 'TABLET', route: 'ORAL', packageSize: 1, packageUnit: 'TABLET', manufacturer: '', barcode: '', prescriptionClass: 'PRESCRIPTION', ingName: '', ingValue: 1, ingUnit: 'MG', confirmDistinct: false });
  const [reason, setReason] = useState('');
  const a = useAction();
  const create = () => a.run(async () => {
    await api('/admin/medicines', { body: { brandNameEn: m.brandNameEn, brandNameAr: m.brandNameAr || undefined, genericNameEn: m.genericNameEn, strength: m.strength, dosageForm: m.dosageForm, route: m.route, packageSize: Number(m.packageSize), packageUnit: m.packageUnit, manufacturer: m.manufacturer, barcode: m.barcode || undefined, prescriptionClass: m.prescriptionClass, ingredients: [{ nameEn: m.ingName, strengthValue: Number(m.ingValue), strengthUnit: m.ingUnit }], confirmDistinct: m.confirmDistinct } });
    await list.reload();
  }, L('Medicine created', 'تمت إضافة الدواء'));
  const set = (k: keyof typeof m) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setM({ ...m, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });
  return (
    <div className="space-y-4">
      <Card>
        <h3 className="mb-2 font-semibold">{L('Add standardized medicine', 'إضافة دواء موحد')}</h3>
        <div className="grid gap-2 sm:grid-cols-4">
          <Field label="Brand (EN)"><input className={inputCls} value={m.brandNameEn} onChange={set('brandNameEn')} /></Field>
          <Field label="الاسم التجاري"><input dir="rtl" className={inputCls} value={m.brandNameAr} onChange={set('brandNameAr')} /></Field>
          <Field label="Generic"><input className={inputCls} value={m.genericNameEn} onChange={set('genericNameEn')} /></Field>
          <Field label="Strength (display)"><input className={inputCls} value={m.strength} onChange={set('strength')} placeholder="500 mg" /></Field>
          <Field label="Form"><select className={inputCls} value={m.dosageForm} onChange={set('dosageForm')}>{FORMS.map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Route"><select className={inputCls} value={m.route} onChange={set('route')}>{ROUTES.map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Package size"><input type="number" min={0.01} step="any" className={inputCls} value={m.packageSize} onChange={set('packageSize')} /></Field>
          <Field label="Package unit"><select className={inputCls} value={m.packageUnit} onChange={set('packageUnit')}>{UNITS.map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Manufacturer"><input className={inputCls} value={m.manufacturer} onChange={set('manufacturer')} /></Field>
          <Field label="Barcode (verified only)"><input className={inputCls} value={m.barcode} onChange={set('barcode')} /></Field>
          <Field label="Class"><select className={inputCls} value={m.prescriptionClass} onChange={set('prescriptionClass')}><option>OTC</option><option>PRESCRIPTION</option><option>CONTROLLED</option></select></Field>
          <Field label="Active ingredient"><input className={inputCls} value={m.ingName} onChange={set('ingName')} /></Field>
          <Field label="Ingredient strength"><input type="number" min={0.0001} step="any" className={inputCls} value={m.ingValue} onChange={set('ingValue')} /></Field>
          <Field label="Unit"><select className={inputCls} value={m.ingUnit} onChange={set('ingUnit')}>{['MG', 'G', 'MCG', 'IU', 'ML', 'PERCENT', 'MG_PER_ML', 'MG_PER_5ML', 'MCG_PER_DOSE', 'UNIT'].map((x) => <option key={x}>{x}</option>)}</select></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={m.confirmDistinct} onChange={set('confirmDistinct')} /> {L('I reviewed similar products; this is distinct', 'راجعت المنتجات المشابهة')}</label>
          <Button disabled={a.pending} onClick={create}>{L('Create', 'إضافة')}</Button>
        </div>
        {a.error && <div className="mt-2"><Alert>{a.error}</Alert></div>}
        {a.ok && <div className="mt-2"><Alert tone="green">{a.ok}</Alert></div>}
      </Card>
      <Card>
        <div className="mb-2 grid gap-2 sm:grid-cols-2"><input aria-label="search" placeholder={L('Search catalog', 'بحث')} className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} /><input aria-label="reason" placeholder={L('Reason for status change (recall etc.)', 'سبب تغيير الحالة')} className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <StateView state={list} empty={(d) => d.items.length === 0}>{(d) => (
          <Table head={[L('Product', 'المنتج'), L('Form / pack', 'الشكل / العبوة'), L('Manufacturer', 'الشركة'), L('Status', 'الحالة'), '']}
            rows={d.items.map((x) => [<span key="n">{x.brandNameEn} {x.strength} {x.brandNameAr && <span className="text-slate-500">· {x.brandNameAr}</span>}{x.dataSource === 'DEV_SEED' && <Badge tone="amber">DEV_SEED</Badge>}</span>, `${x.dosageForm} · ${x.packageSize} ${x.packageUnit}`, x.manufacturer, <Badge key="s" tone={statusTone(x.status)}>{x.status}</Badge>,
              <select key="a" aria-label="status" className={`${inputCls} w-36`} value="" disabled={reason.length < 3} onChange={(e) => e.target.value && a.run(async () => { await api(`/admin/medicines/${x.id}/status`, { body: { status: e.target.value, reason } }); await list.reload(); }, 'OK')}>
                <option value="">{L('Set status…', 'تغيير الحالة…')}</option>{['ACTIVE', 'RECALLED', 'SUSPENDED', 'DISCONTINUED'].filter((s) => s !== x.status).map((s) => <option key={s}>{s}</option>)}</select>])} />)}
        </StateView>
      </Card>
    </div>
  );
}

function SettingsTab({ L }: P) {
  const s = useLoad(() => api<Array<{ key: string; value: unknown; description: string | null; updatedAt: string }>>('/admin/settings'), []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const a = useAction();
  return (
    <Card>
      <p className="mb-2 text-xs text-slate-600">{L('Values are validated server-side; changes are audited and take effect within seconds.', 'يتم التحقق من القيم وتسجيل التغييرات.')}</p>
      {a.error && <Alert>{a.error}</Alert>}
      {a.ok && <Alert tone="green">{a.ok}</Alert>}
      <StateView state={s}>{(rows) => (
        <div className="space-y-3">{rows.map((r) => (
          <div key={r.key} className="grid gap-2 border-b border-slate-100 pb-3 sm:grid-cols-[16rem_1fr_auto] sm:items-start">
            <div><code className="text-sm font-semibold">{r.key}</code><p className="text-xs text-slate-500">{r.description}</p></div>
            <textarea aria-label={r.key} className={`${inputCls} font-mono text-xs`} rows={JSON.stringify(r.value).length > 60 ? 4 : 1} value={drafts[r.key] ?? JSON.stringify(r.value)} onChange={(e) => setDrafts({ ...drafts, [r.key]: e.target.value })} />
            <Button variant="secondary" disabled={drafts[r.key] === undefined || a.pending} onClick={() => a.run(async () => {
              let value: unknown;
              try { value = JSON.parse(drafts[r.key]); } catch { throw new Error(L('Invalid JSON', 'JSON غير صالح')); }
              await api(`/admin/settings/${encodeURIComponent(r.key)}`, { method: 'PUT', body: { value } });
              setDrafts((d) => { const n = { ...d }; delete n[r.key]; return n; });
              await s.reload();
            }, `${r.key} ✓`)}>{L('Save', 'حفظ')}</Button>
          </div>))}
        </div>)}
      </StateView>
    </Card>
  );
}

function Jobs({ L }: P) {
  const j = useLoad(() => api<{ counts: Array<{ type: string; status: string; count: number }>; dead: Array<{ id: number; type: string; attempts: number; lastError: string; updatedAt: string }> }>('/admin/jobs'), []);
  const a = useAction();
  return (
    <StateView state={j}>{(d) => (
      <div className="space-y-4">
        <Card><Table head={['Type', 'Status', 'Count']} rows={d.counts.map((c) => [c.type, <Badge key="s" tone={statusTone(c.status)}>{c.status}</Badge>, c.count])} /></Card>
        <Card>
          <h3 className="mb-2 font-semibold">{L('Dead-letter queue', 'المهام الفاشلة نهائيًا')}</h3>
          {a.error && <Alert>{a.error}</Alert>}
          {d.dead.length === 0 ? <p className="text-sm text-slate-500">—</p> : <Table head={['ID', 'Type', 'Attempts', 'Last error', '']} rows={d.dead.map((x) => [x.id, x.type, x.attempts, x.lastError, <Button key="r" variant="secondary" onClick={() => a.run(async () => { await api(`/admin/jobs/${x.id}/retry`, { method: 'POST', body: {} }); await j.reload(); })}>{L('Retry', 'إعادة')}</Button>])} />}
        </Card>
      </div>)}
    </StateView>
  );
}

function Audit({ L }: P) {
  const [f, setF] = useState({ action: '', entityType: '' });
  const fmt = useDateFmt();
  const list = useLoad(() => api<{ items: Array<{ id: number; occurredAt: string; actorEmail: string | null; actorType: string; action: string; entityType: string; entityId: string | null; summary: string | null; changes: unknown }> }>(`/admin/audit-logs?${qs({ ...f, pageSize: 100 })}`), [f.action, f.entityType]);
  return (
    <Card>
      <div className="mb-2 grid gap-2 sm:grid-cols-2"><input aria-label="action" placeholder="action (e.g. PO_CONFIRMED)" className={inputCls} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value.toUpperCase() })} /><input aria-label="entity" placeholder="entity type (e.g. inventory_item)" className={inputCls} value={f.entityType} onChange={(e) => setF({ ...f, entityType: e.target.value })} /></div>
      <StateView state={list} empty={(d) => d.items.length === 0}>{(d) => (
        <Table head={[L('When', 'الوقت'), L('Actor', 'المنفذ'), L('Action', 'الإجراء'), L('Entity', 'الكيان'), L('Details', 'التفاصيل')]}
          rows={d.items.map((r) => [fmt(r.occurredAt), r.actorEmail ?? r.actorType, r.action, `${r.entityType} ${r.entityId?.slice(0, 8) ?? ''}`, <code key="c" className="block max-w-md truncate text-xs">{r.summary ?? JSON.stringify(r.changes)}</code>])} />)}
      </StateView>
    </Card>
  );
}

function Security({ L }: P) {
  const ev = useLoad(() => api<Array<{ id: number; occurredAt: string; type: string; severity: string; path: string | null; details: unknown }>>('/admin/security-events'), []);
  const fmt = useDateFmt();
  const { user, refresh } = useSession();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const a = useAction();
  return (
    <div className="space-y-4">
      {!user?.mfaEnabled && (
        <Card>
          <h3 className="mb-2 font-semibold">{L('Enable MFA (TOTP)', 'تفعيل المصادقة الثنائية')}</h3>
          {!setup ? <Button onClick={() => a.run(async () => setSetup(await api('/auth/mfa/setup', { method: 'POST', body: {} })))}>{L('Start setup', 'بدء الإعداد')}</Button> : (
            <div className="space-y-2 text-sm"><p>{L('Add this secret to your authenticator app, then enter the 6-digit code:', 'أضف هذا السر لتطبيق المصادقة ثم أدخل الرمز:')}</p><code className="block break-all rounded bg-slate-100 p-2">{setup.secret}</code>
              <div className="flex gap-2"><input inputMode="numeric" maxLength={6} className={`${inputCls} w-32`} value={code} onChange={(e) => setCode(e.target.value)} /><Button onClick={() => a.run(async () => { await api('/auth/mfa/enable', { body: { code } }); await refresh(); }, 'MFA ✓')}>{L('Verify & enable', 'تحقق وتفعيل')}</Button></div></div>)}
          {a.error && <Alert>{a.error}</Alert>}
          {a.ok && <Alert tone="green">{a.ok}</Alert>}
        </Card>
      )}
      <Card>
        <StateView state={ev} empty={(d) => d.length === 0}>{(rows) => (
          <Table head={[L('When', 'الوقت'), L('Type', 'النوع'), L('Severity', 'الخطورة'), L('Path', 'المسار'), L('Details', 'التفاصيل')]}
            rows={rows.map((r) => [fmt(r.occurredAt), r.type, <Badge key="s" tone={r.severity === 'INFO' ? 'slate' : 'red'}>{r.severity}</Badge>, r.path ?? '—', <code key="d" className="text-xs">{JSON.stringify(r.details)}</code>])} />)}
        </StateView>
      </Card>
    </div>
  );
}

function IntegrationsHealth({ L }: P) {
  const list = useLoad(() => api<Array<{ id: string; displayName: string; organizationName: string; status: string; health: string; lastSuccessAt: string | null; consecutiveFailures: number; lastError: string | null }>>('/admin/integrations'), []);
  const fmt = useDateFmt();
  return (
    <Card><StateView state={list} empty={(d) => d.length === 0}>{(rows) => (
      <Table head={[L('Organization', 'المنشأة'), L('Integration', 'التكامل'), L('Status', 'الحالة'), L('Health', 'السلامة'), L('Last success', 'آخر نجاح'), L('Failures', 'الإخفاقات')]}
        rows={rows.map((r) => [r.organizationName, r.displayName, <Badge key="s" tone={statusTone(r.status)}>{r.status}</Badge>, <Badge key="h" tone={statusTone(r.health)}>{r.health}</Badge>, fmt(r.lastSuccessAt), `${r.consecutiveFailures}${r.lastError ? ` · ${r.lastError}` : ''}`])} />)}
    </StateView></Card>
  );
}

function Analytics({ L }: P) {
  const d = useLoad(() => api<{ outcomes: Array<{ outcome: string; count: number; avgLatencyMs: number }>; unmetDemand: Array<{ brandNameEn: string; strength: string; dosageForm: string; searches: number }>; latency: { searches: number; p50Ms: number | null; p95Ms: number | null } }>('/admin/analytics'), []);
  return (
    <StateView state={d}>{(x) => (
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><h3 className="mb-2 font-semibold">{L('Search outcomes (7 days)', 'نتائج البحث (7 أيام)')}</h3><p className="mb-2 text-sm">n={x.latency.searches} · p50 {x.latency.p50Ms ?? '—'} ms · p95 {x.latency.p95Ms ?? '—'} ms</p><Table head={['Outcome', 'Count', 'Avg ms']} rows={x.outcomes.map((o) => [o.outcome, o.count, o.avgLatencyMs])} /></Card>
        <Card><h3 className="mb-2 font-semibold">{L('Unmet demand (30 days)', 'طلب غير ملبى (30 يومًا)')}</h3><Table head={['Medicine', 'Searches']} rows={x.unmetDemand.map((u) => [`${u.brandNameEn} ${u.strength}`, u.searches])} /></Card>
      </div>)}
    </StateView>
  );
}
