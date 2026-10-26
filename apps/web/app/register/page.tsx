'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { Alert, Button, Card, errorText, Field, inputCls } from '@/components/ui';
import { api } from '@/lib/api';
import { useI18n, useSession } from '@/lib/providers';

export default function RegisterPage() {
  const { t, locale } = useI18n();
  const { refresh } = useSession();
  const router = useRouter();
  const [form, setForm] = useState({ fullName: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true); setError(null);
    try {
      await api('/auth/register', { body: { ...form, preferredLocale: locale } });
      await refresh();
      router.push('/');
    } catch (err) { setError(errorText(err)); } finally { setPending(false); }
  };

  return (
    <Card className="mx-auto max-w-md">
      <h1 className="mb-4 text-xl font-bold">{t('register')}</h1>
      <form onSubmit={submit} className="space-y-3">
        <Field label={t('fullName')}><input required minLength={2} maxLength={120} className={inputCls} value={form.fullName} onChange={set('fullName')} /></Field>
        <Field label={t('email')}><input type="email" required autoComplete="email" className={inputCls} value={form.email} onChange={set('email')} /></Field>
        <Field label={t('password')} hint="≥ 10, letters + digits"><input type="password" required minLength={10} autoComplete="new-password" className={inputCls} value={form.password} onChange={set('password')} /></Field>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" disabled={pending} className="w-full">{t('register')}</Button>
      </form>
      <p className="mt-4 text-sm">{t('haveAccount')} <Link className="text-teal-800 underline" href="/login">{t('signIn')}</Link></p>
    </Card>
  );
}
