'use client';

import Link from 'next/link';
import { Alert, Badge, Button, Card, StateView, statusTone, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { useDateFmt, useI18n, useSession } from '@/lib/providers';

interface Req { id: string; referenceCode: string; status: string; requestedQty: number; brandNameEn: string; brandNameAr: string | null; strength: string; pharmacyName: string; pharmacyNameAr: string | null; pharmacyPhone: string | null; pickupCode: string | null; holdExpiresAt: string | null; expiresAt: string; responseNote: string | null }
interface AlertRow { id: string; brandNameEn: string; brandNameAr: string | null; strength: string; radiusKm: number; status: string; expiresAt: string; lastTriggeredAt: string | null }

export default function AccountPage() {
  const { t, locale } = useI18n();
  const { user, loading } = useSession();
  const fmt = useDateFmt();
  const reqs = useLoad(() => api<Req[]>('/me/requests'), [user?.id]);
  const alerts = useLoad(() => api<AlertRow[]>('/me/alerts'), [user?.id]);
  const a = useAction();
  if (!loading && !user) return <Alert tone="amber"><Link className="underline" href="/login?next=/account">{t('navLogin')}</Link></Alert>;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <h1 className="mb-3 text-lg font-bold">{t('myRequests')}</h1>
        {a.error && <Alert>{a.error}</Alert>}
        <StateView state={reqs} empty={(d) => d.length === 0}>{(rows) => (
          <ul className="space-y-3">{rows.map((r) => (
            <li key={r.id} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="me-auto font-semibold">{locale === 'ar' && r.brandNameAr ? r.brandNameAr : r.brandNameEn} {r.strength} × {r.requestedQty}</span>
                <Badge tone={statusTone(r.status)}>{r.status}</Badge>
              </div>
              <p className="text-slate-600">{locale === 'ar' && r.pharmacyNameAr ? r.pharmacyNameAr : r.pharmacyName} · {r.referenceCode}</p>
              {r.pickupCode && <p className="mt-1 font-mono text-base">{t('pickupCode')}: <strong>{r.pickupCode}</strong> · {t('holdUntil')} {fmt(r.holdExpiresAt)}</p>}
              {r.status === 'PENDING' && <p className="text-xs text-slate-500">{t('expires')} {fmt(r.expiresAt)}</p>}
              {r.responseNote && <p className="text-xs">“{r.responseNote}”</p>}
              <div className="mt-2 flex gap-2">
                {r.pharmacyPhone && <a className="text-teal-800 underline" href={`tel:${r.pharmacyPhone.replace(/[^+\d]/g, '')}`}>{t('call')}</a>}
                {['PENDING', 'HELD', 'CONFIRMED_AVAILABLE'].includes(r.status) && <Button variant="ghost" disabled={a.pending} onClick={() => a.run(async () => { await api(`/me/requests/${r.id}/cancel`, { method: 'POST', body: {} }); await reqs.reload(); })}>{t('cancel')}</Button>}
              </div>
            </li>))}
          </ul>)}
        </StateView>
      </Card>
      <Card>
        <h2 className="mb-3 text-lg font-bold">{t('myAlerts')}</h2>
        <StateView state={alerts} empty={(d) => d.length === 0}>{(rows) => (
          <ul className="space-y-3">{rows.map((al) => (
            <li key={al.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-3 text-sm">
              <span className="me-auto">{locale === 'ar' && al.brandNameAr ? al.brandNameAr : al.brandNameEn} {al.strength} · {al.radiusKm} {t('km')}</span>
              <Badge tone={statusTone(al.status)}>{al.status}</Badge>
              {al.status === 'ACTIVE' && <Button variant="ghost" onClick={() => a.run(async () => { await api(`/me/alerts/${al.id}`, { method: 'PATCH', body: { status: 'PAUSED' } }); await alerts.reload(); })}>{t('pause')}</Button>}
              {(al.status === 'PAUSED' || al.status === 'TRIGGERED') && <Button variant="ghost" onClick={() => a.run(async () => { await api(`/me/alerts/${al.id}`, { method: 'PATCH', body: { status: 'ACTIVE' } }); await alerts.reload(); })}>{t('resume')}</Button>}
              <Button variant="ghost" onClick={() => a.run(async () => { await api(`/me/alerts/${al.id}`, { method: 'DELETE' }); await alerts.reload(); })}>{t('remove')}</Button>
            </li>))}
          </ul>)}
        </StateView>
      </Card>
    </div>
  );
}
