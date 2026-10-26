'use client';

import { useRouter } from 'next/navigation';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api';
import { Locale, MessageKey, translate } from './i18n';

export interface Membership { organizationId: string; role: string; type: 'PHARMACY' | 'WAREHOUSE'; nameEn: string; nameAr: string | null; verificationStatus: string; status: string; permissions: string[] }
export interface SessionUser { id: string; email: string; fullName: string; platformRole: 'USER' | 'SUPER_ADMIN'; preferredLocale: Locale; mfaEnabled: boolean }
interface SessionState { user: SessionUser | null; memberships: Membership[]; loading: boolean; refresh: () => Promise<void> }

const I18nCtx = createContext<{ locale: Locale; t: (k: MessageKey | string, v?: Record<string, string | number>) => string; setLocale: (l: Locale) => void }>({ locale: 'ar', t: (k) => String(k), setLocale: () => undefined });
const SessionCtx = createContext<SessionState>({ user: null, memberships: [], loading: true, refresh: async () => undefined });

export function Providers({ locale: initial, children }: { locale: Locale; children: ReactNode }) {
  const router = useRouter();
  const [locale, setLocaleState] = useState<Locale>(initial);
  const [session, setSession] = useState<Omit<SessionState, 'refresh'>>({ user: null, memberships: [], loading: true });

  const setLocale = useCallback((l: Locale) => {
    document.cookie = `sp_locale=${l}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = l;
    document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
    setLocaleState(l);
    router.refresh();
  }, [router]);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: SessionUser | null; memberships: Membership[] }>('/auth/me');
      setSession({ user: me.user, memberships: me.memberships ?? [], loading: false });
    } catch {
      setSession({ user: null, memberships: [], loading: false });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  const t = useCallback((k: MessageKey | string, v?: Record<string, string | number>) => translate(locale, k, v), [locale]);

  return (
    <I18nCtx.Provider value={{ locale, t, setLocale }}>
      <SessionCtx.Provider value={{ ...session, refresh }}>{children}</SessionCtx.Provider>
    </I18nCtx.Provider>
  );
}

export const useI18n = () => useContext(I18nCtx);
export const useSession = () => useContext(SessionCtx);

/** Localized relative time ("5 minutes ago"). */
export function useAgo() {
  const { locale } = useI18n();
  return (date: string | Date | null | undefined) => {
    if (!date) return '—';
    const diff = (new Date(date).getTime() - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const abs = Math.abs(diff);
    if (abs < 60) return rtf.format(Math.round(diff), 'second');
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    return rtf.format(Math.round(diff / 86400), 'day');
  };
}

export function useDateFmt() {
  const { locale } = useI18n();
  return (date: string | Date | null | undefined) => (date ? new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Cairo' }).format(new Date(date)) : '—');
}
