'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n, useSession } from '@/lib/providers';

export function Header({ showDemoBanner }: { showDemoBanner: boolean }) {
  const { t, locale, setLocale } = useI18n();
  const { user, memberships, refresh } = useSession();
  const router = useRouter();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    const load = () => api<{ count: number }>('/me/notifications/unread-count').then((r) => alive && setUnread(r.count)).catch(() => undefined);
    void load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [user]);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    await refresh();
    router.push('/');
  };

  return (
    <header className="border-b border-slate-200 bg-white">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:m-2 focus:rounded focus:bg-white focus:p-2">{t('skip')}</a>
      {showDemoBanner && <div className="bg-amber-100 px-3 py-1 text-center text-xs text-amber-900">{t('demoBanner')}</div>}
      <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3 sm:px-6" aria-label="Main">
        <Link href="/" className="me-auto text-lg font-bold text-teal-800">💊 {t('appName')}</Link>
        <Link href="/" className="text-sm hover:underline">{t('navFind')}</Link>
        {user && memberships.map((m) => (
          <Link key={m.organizationId} href={`/org/${m.organizationId}`} className="text-sm hover:underline">{locale === 'ar' && m.nameAr ? m.nameAr : m.nameEn}</Link>
        ))}
        {user?.platformRole === 'SUPER_ADMIN' && <Link href="/admin" className="text-sm font-medium text-violet-800 hover:underline">{t('navAdmin')}</Link>}
        {user && <Link href="/account" className="text-sm hover:underline">{t('navAccount')}</Link>}
        {user && <Link href="/notifications" className="relative text-sm hover:underline" aria-label={`${t('navNotifications')} (${unread})`}>🔔{unread > 0 && <span className="ms-1 rounded-full bg-red-600 px-1.5 text-xs text-white">{unread}</span>}</Link>}
        {user ? <button onClick={logout} className="text-sm text-slate-600 hover:underline">{t('navLogout')}</button> : <Link href="/login" className="text-sm font-medium text-teal-800 hover:underline">{t('navLogin')}</Link>}
        <button onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} className="rounded border border-slate-300 px-2 py-1 text-xs" lang={locale === 'ar' ? 'en' : 'ar'}>{t('language')}</button>
      </nav>
    </header>
  );
}
