'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { Alert, Button, Card, Field, inputCls } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { Membership, useI18n, useSession } from '@/lib/providers';

function LoginForm() {
  const { t } = useI18n();
  const { refresh } = useSession();
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true); setError(null);
    try {
      const me = await api<{ user: { platformRole: string }; memberships: Membership[] }>('/auth/login', { body: { email, password, totpCode: needTotp ? totpCode : undefined } });
      await refresh();
      // Only same-site relative redirects are honoured (prevents open redirects).
      const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;
      router.push(safeNext ?? (me.user.platformRole === 'SUPER_ADMIN' ? '/admin' : me.memberships[0] ? `/org/${me.memberships[0].organizationId}` : '/'));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_REQUIRED') { setNeedTotp(true); setError(err.message); }
      else setError(err instanceof ApiError ? err.message : t('errorGeneric'));
    } finally { setPending(false); }
  };

  return (
    <Card className="mx-auto max-w-md">
      <h1 className="mb-4 text-xl font-bold">{t('signIn')}</h1>
      <form onSubmit={submit} className="space-y-3">
        <Field label={t('email')}><input type="email" required autoComplete="username" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t('password')}><input type="password" required autoComplete="current-password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {needTotp && <Field label={t('totp')}><input inputMode="numeric" pattern="\d{6}" maxLength={6} required autoComplete="one-time-code" className={inputCls} value={totpCode} onChange={(e) => setTotp(e.target.value)} /></Field>}
        {error && <Alert>{error}</Alert>}
        <Button type="submit" disabled={pending} className="w-full">{pending ? t('signingIn') : t('signIn')}</Button>
      </form>
      <p className="mt-4 text-sm">{t('noAccount')} <Link className="text-teal-800 underline" href="/register">{t('register')}</Link></p>
      <p className="mt-1 text-sm"><Link className="text-teal-800 underline" href="/register/business">{t('navBusiness')}</Link></p>
    </Card>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
