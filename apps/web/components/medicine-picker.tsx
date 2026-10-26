'use client';

import { useEffect, useId, useState } from 'react';
import { api, qs } from '@/lib/api';
import { useI18n } from '@/lib/providers';
import { Badge, Button, inputCls } from './ui';

export interface MedicineOption {
  id: string; brandNameEn: string; brandNameAr: string | null; genericNameEn: string; strength: string; dosageForm: string;
  packageSize: number; packageUnit: string; manufacturer: string; status: string; prescriptionClass: string; dataSource?: string;
}

export const formLabel = (m: Pick<MedicineOption, 'dosageForm' | 'packageSize' | 'packageUnit'>) =>
  `${m.dosageForm.replace(/_/g, ' ').toLowerCase()} · ${m.packageSize} ${m.packageUnit.toLowerCase()}`;

/** Catalog search with explicit user selection (never auto-selects; shows distinguishing attributes). */
export function MedicinePicker({ value, onChange, label }: { value: MedicineOption | null; onChange: (m: MedicineOption | null) => void; label?: string }) {
  const { t, locale } = useI18n();
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<MedicineOption[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'done'>('idle');
  const listId = useId();

  useEffect(() => {
    if (value || q.trim().length < 2) { setOptions([]); setState('idle'); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setState('loading');
      try {
        setOptions(await api<MedicineOption[]>(`/catalog/medicines?${qs({ q: q.trim(), limit: 12 })}`, { signal: ctrl.signal }));
        setState('done');
      } catch (e) { if ((e as Error).name !== 'AbortError') setState('error'); }
    }, 250);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [q, value]);

  const name = (m: MedicineOption) => (locale === 'ar' && m.brandNameAr ? `${m.brandNameAr} (${m.brandNameEn})` : m.brandNameEn);

  if (value) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-teal-300 bg-teal-50 px-3 py-2">
        <div className="me-auto">
          <div className="font-semibold">{name(value)} <span className="font-normal">{value.strength}</span></div>
          <div className="text-xs text-slate-600">{value.genericNameEn} · {formLabel(value)} · {value.manufacturer}</div>
        </div>
        {value.status !== 'ACTIVE' && <Badge tone="red">{value.status}</Badge>}
        <Button variant="ghost" onClick={() => { onChange(null); setQ(''); }}>{t('change')}</Button>
      </div>
    );
  }
  return (
    <div className="relative">
      <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor={`${listId}-input`}>{label ?? t('medicine')}</label>
      <input id={`${listId}-input`} className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('medicinePlaceholder')}
        role="combobox" aria-expanded={options.length > 0} aria-controls={listId} autoComplete="off" maxLength={100} />
      {state === 'loading' && <p className="mt-1 text-xs text-slate-500">{t('loading')}</p>}
      {state === 'error' && <p className="mt-1 text-xs text-red-700">{t('errorGeneric')}</p>}
      {state === 'done' && options.length === 0 && <p className="mt-1 text-xs text-slate-500">{t('empty')}</p>}
      {options.length > 0 && (
        <>
          <p className="mt-1 text-xs text-amber-800">{t('chooseExact')}</p>
          <ul id={listId} role="listbox" className="mt-1 max-h-80 overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
            {options.map((m) => (
              <li key={m.id} role="option" aria-selected={false}>
                <button type="button" onClick={() => onChange(m)} className="w-full border-b border-slate-100 px-3 py-2 text-start hover:bg-teal-50">
                  <span className="font-semibold">{name(m)}</span> <span>{m.strength}</span>
                  {m.status !== 'ACTIVE' && <span className="ms-2"><Badge tone="red">{m.status}</Badge></span>}
                  {m.dataSource === 'DEV_SEED' && <span className="ms-2"><Badge tone="amber">{t('demo')}</Badge></span>}
                  <span className="block text-xs text-slate-600">{m.genericNameEn} · {formLabel(m)} · {m.manufacturer}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
