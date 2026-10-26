'use client';

import { ButtonHTMLAttributes, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/providers';

export function cx(...c: Array<string | false | null | undefined>) { return c.filter(Boolean).join(' '); }

export function Button({ variant = 'primary', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }) {
  const styles = {
    primary: 'bg-teal-700 text-white hover:bg-teal-800 disabled:bg-teal-700/50',
    secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:opacity-50',
    danger: 'bg-red-700 text-white hover:bg-red-800 disabled:bg-red-700/50',
    ghost: 'text-teal-800 hover:bg-teal-50 disabled:opacity-50',
  }[variant];
  return <button {...p} className={cx('inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed', styles, className)} />;
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('rounded-xl border border-slate-200 bg-white p-4 shadow-sm', className)}>{children}</section>;
}

const tones = { green: 'bg-green-100 text-green-900', amber: 'bg-amber-100 text-amber-900', red: 'bg-red-100 text-red-900', blue: 'bg-sky-100 text-sky-900', slate: 'bg-slate-100 text-slate-800', purple: 'bg-violet-100 text-violet-900' };
export function Badge({ tone = 'slate', children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold', tones[tone])}>{children}</span>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputCls = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-teal-600';

export function Alert({ tone = 'red', children }: { tone?: 'red' | 'amber' | 'green' | 'blue'; children: ReactNode }) {
  const s = { red: 'border-red-200 bg-red-50 text-red-900', amber: 'border-amber-200 bg-amber-50 text-amber-900', green: 'border-green-200 bg-green-50 text-green-900', blue: 'border-sky-200 bg-sky-50 text-sky-900' }[tone];
  return <div role={tone === 'red' ? 'alert' : 'status'} className={cx('rounded-lg border px-3 py-2 text-sm', s)}>{children}</div>;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const details = Array.isArray(e.details) ? (e.details as Array<{ path?: string; message?: string }>).map((d) => `${d.path ? `${d.path}: ` : ''}${d.message}`).join('; ') : '';
    return details ? `${e.message} (${details})` : e.message;
  }
  return (e as Error)?.message ?? 'Error';
}

/** Loads data with explicit loading / error / empty states and a reload function. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: undefined }));
    try { setState({ data: await fnRef.current(), loading: false }); } catch (error) { setState({ error, loading: false }); }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, deps);
  return { ...state, reload };
}

export function StateView<T>({ state, empty, children }: { state: { data?: T; error?: unknown; loading: boolean; reload: () => void }; empty?: (d: T) => boolean; children: (d: T) => ReactNode }) {
  const { t } = useI18n();
  if (state.loading && state.data === undefined) return <p className="py-6 text-center text-sm text-slate-500" aria-live="polite">{t('loading')}</p>;
  if (state.error) return <div className="space-y-2"><Alert>{errorText(state.error)}</Alert><Button variant="secondary" onClick={state.reload}>{t('retry')}</Button></div>;
  if (state.data === undefined) return null;
  if (empty?.(state.data)) return <p className="py-6 text-center text-sm text-slate-500">{t('empty')}</p>;
  return <>{children(state.data)}</>;
}

/** Runs an async action with pending + error display; prevents double submission. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>, success?: string) => {
    setPending(true); setError(null); setOk(null);
    try { await fn(); if (success) setOk(success); return true; } catch (e) { setError(errorText(e)); return false; } finally { setPending(false); }
  }, []);
  return { pending, error, ok, run, setError };
}

export function Tabs<K extends string>({ tabs, active, onChange }: { tabs: Array<[K, string]>; active: K; onChange: (k: K) => void }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-slate-200 pb-px">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={active === k} onClick={() => onChange(k)}
          className={cx('whitespace-nowrap rounded-t-lg px-3 py-2 text-sm font-medium', active === k ? 'border-b-2 border-teal-700 text-teal-800' : 'text-slate-600 hover:text-slate-900')}>{label}</button>
      ))}
    </div>
  );
}

export function Table({ head, rows }: { head: ReactNode[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead><tr className="border-b border-slate-200 text-start text-xs uppercase text-slate-500">{head.map((h, i) => <th key={i} className="px-2 py-2 text-start font-semibold">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-slate-100 align-top">{r.map((c, j) => <td key={j} className="px-2 py-2">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export const statusTone = (s: string): keyof typeof tones =>
  /AVAILABLE$|^DELIVERED|CONFIRMED$|VERIFIED|ACTIVE|HEALTHY|SUCCEEDED|RESOLVED|HELD|PROCESSED/.test(s) && !/NOT_AVAILABLE|UNAVAILABLE/.test(s) ? 'green'
    : /LOW|PARTIAL|PENDING|UNCONFIRMED|INSUFFICIENT|ESTIMATED|SUBMITTED|DRAFT|IN_|DISPATCHED|ARRIVED|ACKNOWLEDGED|TRIGGERED/.test(s) ? 'amber'
      : /STALE|DELAYED|REJECTED|CANCELLED|SUSPENDED|FAILING|DEAD|RECALLED|OUT_OF|NOT_AVAILABLE|UNAVAILABLE|EXPIRED|MISSING|DAMAGED|DISPUTED|OPEN/.test(s) ? 'red' : 'slate';
