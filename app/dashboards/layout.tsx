import type { Metadata } from 'next';

import './dashboards.css';

export const metadata: Metadata = {
  title: 'Helios Dashboards',
  robots: { index: false, follow: false },
  icons: { icon: '/dashboards/favicon.png' },
};

export default function DashboardsRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <link
        href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700;900&display=swap"
        rel="stylesheet"
      />
      <div className="dashboards-root">{children}</div>
    </>
  );
}
