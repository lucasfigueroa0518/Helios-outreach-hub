import { Roboto } from 'next/font/google';
import localFont from 'next/font/local';
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${roboto.variable} ${pragmatica.variable}`}>
      <body>{children}</body>
    </html>
  );
}
