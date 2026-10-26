'use client';

import { Button, Card, cx, StateView, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { useDateFmt, useI18n, useSession } from '@/lib/providers';

interface Note { id: string; type: string; title: string; body: string; readAt: string | null; createdAt: string }

export default function NotificationsPage() {
  const { t } = useI18n();
  const { user } = useSession();
  const fmt = useDateFmt();
  const notes = useLoad(() => api<Note[]>('/me/notifications'), [user?.id]);
  const markAll = async () => { await api('/me/notifications/read', { body: { all: true } }); await notes.reload(); };
  return (
    <Card>
      <div className="mb-3 flex items-center"><h1 className="me-auto text-lg font-bold">{t('navNotifications')}</h1><Button variant="secondary" onClick={markAll}>{t('markAllRead')}</Button></div>
      <StateView state={notes} empty={(d) => d.length === 0}>{(rows) => (
        <ul className="divide-y divide-slate-100">{rows.map((n) => (
          <li key={n.id} className={cx('py-3', !n.readAt && 'bg-teal-50/50')}>
            <p className="font-medium">{n.title}</p>
            <p className="text-sm text-slate-700">{n.body}</p>
            <p className="text-xs text-slate-500">{fmt(n.createdAt)}</p>
          </li>))}
        </ul>)}
      </StateView>
    </Card>
  );
}
