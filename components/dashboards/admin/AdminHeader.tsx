'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import SignOutButton from '@/components/dashboards/admin/SignOutButton';

const NAV = [
  { href: '/dashboards', label: 'Projects', match: (path: string) => path === '/dashboards' || path.startsWith('/dashboards/projects') },
  { href: '/dashboards/tokens', label: 'Tokens', match: (path: string) => path.startsWith('/dashboards/tokens') },
] as const;

export default function AdminHeader({ email }: { email: string }) {
  const pathname = usePathname() || '/dashboards';

  return (
    <header className="dashboards-admin-header">
      <div className="dashboards-admin-header__inner">
        <div className="dashboards-admin-header__left">
          <Link href="/" className="dashboards-admin-header__brand" aria-label="Back to Helios">
            <Image
              src="/dashboards/helios-logo.png"
              alt="Helios"
              width={100}
              height={32}
              className="dashboards-admin-header__logo"
              priority
            />
            <span className="dashboards-admin-header__product">Dashboards</span>
          </Link>

          <nav className="dashboards-admin-header__nav" aria-label="Dashboards">
            {NAV.map((item) => {
              const active = item.match(pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`dashboards-admin-header__nav-link${active ? ' is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="dashboards-admin-header__right">
          <span className="dashboards-admin-header__email">{email}</span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
