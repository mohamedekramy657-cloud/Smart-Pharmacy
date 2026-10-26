import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { ReactNode } from 'react';
import { Header } from '@/components/header';
import { Locale } from '@/lib/i18n';
import { Providers } from '@/lib/providers';
import './globals.css';

export const metadata: Metadata = { title: 'Smart Pharmacy · الصيدلية الذكية', description: 'Find nearby pharmacies with your medicine in stock (Egypt).' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0f766e' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  const locale: Locale = store.get('sp_locale')?.value === 'en' ? 'en' : 'ar';
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <Providers locale={locale}>
          <Header showDemoBanner={process.env.NEXT_PUBLIC_SHOW_DEMO_BANNER !== 'false'} />
          <main id="main" className="mx-auto w-full max-w-6xl px-3 py-4 sm:px-6">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
