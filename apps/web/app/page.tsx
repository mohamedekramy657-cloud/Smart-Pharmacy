'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { MedicineOption, MedicinePicker } from '@/components/medicine-picker';
import { Alert, Badge, Button, Card, cx, errorText, Field, inputCls, statusTone, useAction } from '@/components/ui';
import { api, ApiError, newIdempotencyKey, qs } from '@/lib/api';
import { useAgo, useDateFmt, useI18n, useSession } from '@/lib/providers';

const MapPicker = dynamic(() => import('@/components/map-picker').then((m) => m.MapPicker), { ssr: false });

interface City { id: number; nameEn: string; nameAr: string; lat: number; lng: number }
interface Result {
  pharmacy: { id: string; nameEn: string; nameAr: string | null; addressLine: string; phone: string | null; cityNameEn: string | null; cityNameAr: string | null; districtNameEn: string | null; districtNameAr: string | null; lat: number; lng: number; is24h: boolean; openNow: boolean | null; deliveryAvailable: boolean; acceptsConfirmationRequests: boolean; isDemo: boolean };
  distanceKm: number;
  availability: { status: string; freshness: string; lastUpdatedAt: string; source: string; quantity: number | null; quantityBucket: string };
  price: { amount: string; currency: string } | null;
  directions: { google: string; osm: string };
}
interface Incoming { pharmacyId: string; nameEn: string; nameAr: string | null; phone: string | null; distanceKm: number; estimatedDeliveryAt: string | null; deliveryDateStatus: string }
interface SearchResponse { outcome: string; matchedRadiusKm: number | null; searchedRadiusKm: number | null; radiiKm: number[]; results: Result[]; stale: Result[]; incoming: Incoming[]; total: number; disclaimer: string; productStatus?: string; productStatusReason?: string; coverage?: { verifiedPharmaciesWithinMaxRadius: number }; origin: { precision: string } }

type LocMode = 'gps' | 'area' | 'map';
const DEFAULT_CENTER = { lat: 30.5965, lng: 32.2715 }; // Ismailia (map start position only)

export default function FinderPage() {
  const { t, locale } = useI18n();
  const { user } = useSession();
  const [medicine, setMedicine] = useState<MedicineOption | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [mode, setMode] = useState<LocMode>('area');
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [cities, setCities] = useState<City[]>([]);
  const [cityId, setCityId] = useState<number | ''>('');
  const [districts, setDistricts] = useState<City[]>([]);
  const [districtId, setDistrictId] = useState<number | ''>('');
  const [openNow, setOpenNow] = useState(false);
  const [resp, setResp] = useState<SearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { api<City[]>('/geo/cities').then(setCities).catch(() => setCities([])); }, []);
  useEffect(() => {
    setDistrictId('');
    if (cityId === '') { setDistricts([]); return; }
    api<City[]>(`/geo/cities/${cityId}/districts`).then(setDistricts).catch(() => setDistricts([]));
  }, [cityId]);

  const locate = () => {
    setMode('gps'); setGeoMsg(t('locating'));
    if (!('geolocation' in navigator)) { setGeoMsg(t('geoUnavailable')); setMode('area'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { setPoint({ lat: Math.round(p.coords.latitude * 1e4) / 1e4, lng: Math.round(p.coords.longitude * 1e4) / 1e4 }); setGeoMsg(t('locationSet')); },
      (err) => { setGeoMsg(err.code === err.PERMISSION_DENIED ? t('geoDenied') : t('geoUnavailable')); setMode('area'); setPoint(null); },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  };

  const locationParams = () => (mode === 'area' ? { cityId: cityId || undefined, districtId: districtId || undefined } : point ? { lat: point.lat, lng: point.lng, locationMethod: mode === 'gps' ? 'GPS' : 'MAP_PIN' } : {});
  const hasLocation = mode === 'area' ? cityId !== '' : point !== null;

  const runSearch = async (expandToMax = false) => {
    if (!medicine || !hasLocation) return;
    setLoading(true); setSearchError(null);
    try {
      setResp(await api<SearchResponse>(`/finder/search?${qs({ medicineId: medicine.id, quantity, openNow: openNow || undefined, expandToMax: expandToMax || undefined, ...locationParams() })}`));
    } catch (e) {
      setResp(null);
      setSearchError(e instanceof ApiError && (e.status >= 500 || e.status === 0) ? t('serviceUnavailable') : errorText(e));
    } finally { setLoading(false); }
  };
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void runSearch(); };
  const maxKm = resp?.radiiKm[resp.radiiKm.length - 1];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t('tagline')}</h1>
      </div>
      <Card>
        <form onSubmit={onSubmit} className="space-y-4">
          <MedicinePicker value={medicine} onChange={(m) => { setMedicine(m); setResp(null); }} />
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <Field label={t('quantity')}>
              <input type="number" min={1} max={100} value={quantity} onChange={(e) => setQuantity(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} className={inputCls} />
            </Field>
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-slate-700">{t('location')}</legend>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant={mode === 'gps' ? 'primary' : 'secondary'} onClick={locate}>📍 {t('useMyLocation')}</Button>
                <Button type="button" variant={mode === 'area' ? 'primary' : 'secondary'} onClick={() => setMode('area')}>{t('chooseArea')}</Button>
                <Button type="button" variant={mode === 'map' ? 'primary' : 'secondary'} onClick={() => { setMode('map'); setPoint(null); }}>🗺️ {t('pickOnMap')}</Button>
              </div>
              <p className="mt-1 text-xs text-slate-500">{t('geoConsent')}</p>
              {geoMsg && <p className="mt-1 text-xs text-slate-700" role="status">{geoMsg}</p>}
            </fieldset>
          </div>
          {mode === 'area' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('city')}>
                <select className={inputCls} value={cityId} onChange={(e) => setCityId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">{t('selectCity')}</option>
                  {cities.map((c) => <option key={c.id} value={c.id}>{locale === 'ar' ? c.nameAr : c.nameEn}</option>)}
                </select>
              </Field>
              <Field label={t('district')}>
                <select className={inputCls} value={districtId} onChange={(e) => setDistrictId(e.target.value ? Number(e.target.value) : '')} disabled={!districts.length}>
                  <option value="">{t('anyDistrict')}</option>
                  {districts.map((d) => <option key={d.id} value={d.id}>{locale === 'ar' ? d.nameAr : d.nameEn}</option>)}
                </select>
              </Field>
            </div>
          )}
          {mode === 'map' && <MapPicker center={DEFAULT_CENTER} value={point} onPick={setPoint} unavailableText={t('geoUnavailable')} />}
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={openNow} onChange={(e) => setOpenNow(e.target.checked)} /> {t('openNowOnly')}</label>
            <Button type="submit" disabled={!medicine || !hasLocation || loading} className="ms-auto min-w-32">{loading ? t('searching') : t('search')}</Button>
          </div>
        </form>
      </Card>

      {searchError && <Alert>{searchError}</Alert>}
      {resp && (
        <div className="space-y-4" aria-live="polite">
          <Card className={cx(resp.outcome === 'FOUND' ? 'border-green-200' : 'border-amber-200')}>
            <h2 className="text-lg font-semibold">{t(`out_${resp.outcome}`)}</h2>
            {resp.outcome !== 'FOUND' && <p className="mt-1 text-sm text-slate-700">{t(`outd_${resp.outcome}`)}</p>}
            {resp.productStatusReason && <p className="mt-1 text-sm text-red-800">{resp.productStatusReason}</p>}
            {resp.searchedRadiusKm && <p className="mt-1 text-sm text-slate-600">{resp.matchedRadiusKm ? t('foundWithin', { km: resp.matchedRadiusKm }) : t('noneWithin', { km: resp.searchedRadiusKm })} · {resp.total}</p>}
            {resp.origin.precision !== 'EXACT' && <p className="text-xs text-slate-500">≈ {resp.origin.precision === 'CITY' ? t('city') : t('district')}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {resp.matchedRadiusKm && maxKm && resp.searchedRadiusKm! < maxKm && <Button variant="secondary" onClick={() => runSearch(true)}>{t('expand', { km: maxKm })}</Button>}
              {resp.outcome !== 'FOUND' && resp.outcome !== 'PRODUCT_UNAVAILABLE' && resp.outcome !== 'NOT_PUBLICLY_LISTED' && medicine && <AlertButton medicineId={medicine.id} location={locationParams()} />}
            </div>
          </Card>
          {resp.results.map((r) => <ResultCard key={r.pharmacy.id} r={r} medicineId={medicine!.id} quantity={quantity} loggedIn={!!user} />)}
          {resp.stale.length > 0 && (
            <details className="rounded-xl border border-amber-300 bg-amber-50 p-3">
              <summary className="cursor-pointer font-semibold text-amber-900">{t('staleSection')} ({resp.stale.length})</summary>
              <div className="mt-3 space-y-3">{resp.stale.map((r) => <ResultCard key={r.pharmacy.id} r={r} medicineId={medicine!.id} quantity={quantity} loggedIn={!!user} />)}</div>
            </details>
          )}
          {resp.incoming.length > 0 && <IncomingSection items={resp.incoming} />}
          <p className="text-xs text-slate-500">{t('disclaimer')}</p>
        </div>
      )}
    </div>
  );
}

function ResultCard({ r, medicineId, quantity, loggedIn }: { r: Result; medicineId: string; quantity: number; loggedIn: boolean }) {
  const { t, locale } = useI18n();
  const ago = useAgo();
  const [requesting, setRequesting] = useState(false);
  const p = r.pharmacy;
  const area = [locale === 'ar' ? p.districtNameAr : p.districtNameEn, locale === 'ar' ? p.cityNameAr : p.cityNameEn].filter(Boolean).join('، ');
  return (
    <Card>
      <div className="flex flex-wrap items-start gap-2">
        <div className="me-auto">
          <h3 className="text-base font-semibold">{locale === 'ar' && p.nameAr ? p.nameAr : p.nameEn}</h3>
          <p className="text-sm text-slate-600">{p.addressLine}{area && ` — ${area}`}</p>
        </div>
        <span className="text-lg font-bold text-teal-800" aria-label={`${r.distanceKm} ${t('km')}`}>{r.distanceKm.toLocaleString(locale === 'ar' ? 'ar-EG' : 'en')} {t('km')}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge tone={statusTone(r.availability.status)}>{t(`st_${r.availability.status}`)}</Badge>
        <Badge tone="blue">✓ {t('verified')}</Badge>
        {p.isDemo && <Badge tone="amber">{t('demo')}</Badge>}
        {p.is24h ? <Badge tone="green">{t('open24')}</Badge> : p.openNow === true ? <Badge tone="green">{t('openNow')}</Badge> : p.openNow === false ? <Badge tone="red">{t('closed')}</Badge> : <Badge>{t('hoursUnknown')}</Badge>}
        {p.deliveryAvailable && <Badge tone="purple">{t('delivery')}</Badge>}
        <Badge>{r.availability.quantity !== null ? `${r.availability.quantity}` : t(`qb_${r.availability.quantityBucket}`)}</Badge>
      </div>
      <p className="mt-2 text-xs text-slate-600">{t('updatedAgo', { ago: ago(r.availability.lastUpdatedAt) })} {t(`src_${r.availability.source}`)}</p>
      {r.price && <p className="text-sm">{r.price.amount} {r.price.currency}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <a className="rounded-lg bg-teal-700 px-3 py-2 text-sm font-medium text-white hover:bg-teal-800" href={r.directions.google} target="_blank" rel="noopener noreferrer">🧭 {t('directions')}</a>
        <a className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50" href={r.directions.osm} target="_blank" rel="noopener noreferrer">{t('osm')}</a>
        {p.phone && <a className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50" href={`tel:${p.phone.replace(/[^+\d]/g, '')}`}>📞 {t('call')}</a>}
        {p.acceptsConfirmationRequests && (loggedIn
          ? <Button variant="secondary" onClick={() => setRequesting((v) => !v)}>{t('requestConfirm')}</Button>
          : <Link href="/login?next=/" className="rounded-lg px-3 py-2 text-sm text-teal-800 underline">{t('loginToRequest')}</Link>)}
      </div>
      {requesting && <RequestForm pharmacyId={p.id} medicineId={medicineId} quantity={quantity} />}
    </Card>
  );
}

function RequestForm({ pharmacyId, medicineId, quantity }: { pharmacyId: string; medicineId: string; quantity: number }) {
  const { t } = useI18n();
  const [wantsHold, setWantsHold] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const [code, setCode] = useState<string | null>(null);
  const a = useAction();
  const send = () => a.run(async () => {
    const r = await api<{ referenceCode: string }>('/me/requests', { body: { pharmacyOrgId: pharmacyId, medicineId, quantity, wantsHold }, idempotencyKey: key });
    setCode(r.referenceCode);
  });
  return (
    <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={wantsHold} onChange={(e) => setWantsHold(e.target.checked)} /> {t('askHold')}</label>
      <Button onClick={send} disabled={a.pending || !!code}>{t('send')}</Button>
      {a.error && <Alert>{a.error}</Alert>}
      {code && <Alert tone="green">{t('requestSent', { code })} <Link className="underline" href="/account">{t('navAccount')}</Link></Alert>}
    </div>
  );
}

function AlertButton({ medicineId, location }: { medicineId: string; location: Record<string, unknown> }) {
  const { t } = useI18n();
  const { user } = useSession();
  const a = useAction();
  if (!user) return <Link href="/login?next=/" className="px-2 py-2 text-sm text-teal-800 underline">{t('loginToRequest')}</Link>;
  const create = () => a.run(() => api('/me/alerts', { body: { medicineId, radiusKm: 10, lat: location.lat, lng: location.lng, cityId: location.cityId, districtId: location.districtId } }), t('alertCreated'));
  return (
    <div className="space-y-2">
      <Button variant="secondary" onClick={create} disabled={a.pending || !!a.ok}>🔔 {t('createAlert')}</Button>
      {a.error && <Alert>{a.error}</Alert>}
      {a.ok && <Alert tone="green">{a.ok}</Alert>}
    </div>
  );
}

function IncomingSection({ items }: { items: Incoming[] }) {
  const { t, locale } = useI18n();
  const fmt = useDateFmt();
  return (
    <Card className="border-sky-200 bg-sky-50/50">
      <h3 className="font-semibold">{t('incomingSection')}</h3>
      <p className="text-xs text-slate-600">{t('incomingNote')}</p>
      <ul className="mt-2 space-y-2">
        {items.map((i) => (
          <li key={i.pharmacyId} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="me-auto font-medium">{locale === 'ar' && i.nameAr ? i.nameAr : i.nameEn} · {i.distanceKm} {t('km')}</span>
            <span>{t('eta')}: {fmt(i.estimatedDeliveryAt)}</span>
            <Badge tone={statusTone(i.deliveryDateStatus)}>{t(`dd_${i.deliveryDateStatus}`)}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}
