'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { Alert, Button, Card, errorText, Field, inputCls } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n, useSession } from '@/lib/providers';

interface City { id: number; nameEn: string; nameAr: string; lat: number; lng: number }

/** Business onboarding: account + organization, created as PENDING until an admin verifies it. */
export default function RegisterBusinessPage() {
  const { t, locale } = useI18n();
  const { user, refresh } = useSession();
  const router = useRouter();
  const [cities, setCities] = useState<City[]>([]);
  const [acc, setAcc] = useState({ fullName: '', email: '', password: '' });
  const [org, setOrg] = useState({ type: 'PHARMACY', nameEn: '', nameAr: '', licenseNumber: '', registrationNumber: '', addressLine: '', cityId: '', lat: '', lng: '', phone: '', submissionNotes: '' });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => { api<City[]>('/geo/cities').then(setCities).catch(() => undefined); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true); setError(null);
    try {
      const body = {
        account: user ? undefined : { ...acc, preferredLocale: locale },
        organization: { type: org.type, nameEn: org.nameEn, nameAr: org.nameAr || undefined, licenseNumber: org.licenseNumber, registrationNumber: org.registrationNumber || undefined, addressLine: org.addressLine,
          cityId: org.cityId ? Number(org.cityId) : undefined, lat: Number(org.lat), lng: Number(org.lng), phone: org.phone, submissionNotes: org.submissionNotes || undefined },
      };
      const r = await api<{ organizationId: string }>('/auth/register-organization', { body });
      await refresh();
      router.push(`/org/${r.organizationId}`);
    } catch (err) { setError(errorText(err)); } finally { setPending(false); }
  };
  const so = (k: keyof typeof org) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setOrg({ ...org, [k]: e.target.value });

  return (
    <Card className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-xl font-bold">{t('navBusiness')}</h1>
      <p className="mb-4 text-sm text-slate-600">{t('orgPending')}</p>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        {!user && <>
          <Field label={t('fullName')}><input required className={inputCls} value={acc.fullName} onChange={(e) => setAcc({ ...acc, fullName: e.target.value })} /></Field>
          <Field label={t('email')}><input type="email" required className={inputCls} value={acc.email} onChange={(e) => setAcc({ ...acc, email: e.target.value })} /></Field>
          <Field label={t('password')} hint="≥ 10, letters + digits"><input type="password" required minLength={10} className={inputCls} value={acc.password} onChange={(e) => setAcc({ ...acc, password: e.target.value })} /></Field>
        </>}
        <Field label="Type / النوع"><select className={inputCls} value={org.type} onChange={so('type')}><option value="PHARMACY">Pharmacy / صيدلية</option><option value="WAREHOUSE">Warehouse / مخزن أدوية</option></select></Field>
        <Field label="Name (English)"><input required minLength={2} className={inputCls} value={org.nameEn} onChange={so('nameEn')} /></Field>
        <Field label="الاسم (عربي)"><input className={inputCls} value={org.nameAr} onChange={so('nameAr')} dir="rtl" /></Field>
        <Field label="License number / رقم الترخيص"><input required minLength={3} className={inputCls} value={org.licenseNumber} onChange={so('licenseNumber')} /></Field>
        <Field label="Commercial registration / السجل التجاري"><input className={inputCls} value={org.registrationNumber} onChange={so('registrationNumber')} /></Field>
        <Field label="Phone / الهاتف"><input required className={inputCls} value={org.phone} onChange={so('phone')} /></Field>
        <Field label={t('city')}><select className={inputCls} value={org.cityId} onChange={(e) => { const c = cities.find((x) => String(x.id) === e.target.value); setOrg({ ...org, cityId: e.target.value, lat: org.lat || (c ? String(c.lat) : ''), lng: org.lng || (c ? String(c.lng) : '') }); }}><option value="">—</option>{cities.map((c) => <option key={c.id} value={c.id}>{locale === 'ar' ? c.nameAr : c.nameEn}</option>)}</select></Field>
        <div className="sm:col-span-2"><Field label="Address / العنوان"><input required minLength={5} className={inputCls} value={org.addressLine} onChange={so('addressLine')} /></Field></div>
        <Field label="Latitude" hint="Exact pharmacy location is verified by an administrator"><input required type="number" step="any" min={-90} max={90} className={inputCls} value={org.lat} onChange={so('lat')} /></Field>
        <Field label="Longitude"><input required type="number" step="any" min={-180} max={180} className={inputCls} value={org.lng} onChange={so('lng')} /></Field>
        <div className="sm:col-span-2"><Field label={t('note')}><textarea maxLength={1000} className={inputCls} value={org.submissionNotes} onChange={so('submissionNotes')} /></Field></div>
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <div className="sm:col-span-2"><Button type="submit" disabled={pending}>{t('submit')}</Button></div>
      </form>
    </Card>
  );
}
