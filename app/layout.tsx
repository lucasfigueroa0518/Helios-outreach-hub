import { Roboto } from 'next/font/google';
import localFont from 'next/font/local';

import { SiteProductMenu } from '@/app/site-product-menu';
import { getSession } from '@/lib/session';

import './globals.css';
import './components.css';

const roboto = Roboto({
  subsets: ['latin'],
  weight: ['300', '400', '500', '700'],
  variable: '--font-roboto',
  display: 'swap',
});

const pragmatica = localFont({
  src: './fonts/PragmaticaExtended-Bold.otf',
  weight: '700',
  style: 'normal',
  variable: '--font-pragmatica',
  display: 'swap',
});

export const metadata = {
  title: 'Outreach Hub',
  description: 'Outreach Hub — lead enrichment for Embark',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  return (
    <html lang="en" className={`${roboto.variable} ${pragmatica.variable}`}>
      <body className={session ? 'has-site-product-menu' : undefined}>
        {session ? <SiteProductMenu /> : null}
        {children}
      </body>
    </html>
  );
}
