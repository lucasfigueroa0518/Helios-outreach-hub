'use client';

import Link from 'next/link';
import { signOut } from 'next-auth/react';

type Props = {
  email: string;
};

export function ProductChooser({ email }: Props) {
  return (
    <div className="login-page product-chooser">
      <div className="login-page__atmosphere" aria-hidden="true">
        <span className="login-page__orb login-page__orb--a" />
        <span className="login-page__orb login-page__orb--b" />
        <span className="login-page__orb login-page__orb--c" />
        <span className="login-page__grid" />
      </div>

      <section className="login-page__stage product-chooser__stage" aria-label="Choose a product">
        <h1 className="login-page__brand">
          <span className="login-page__brand-line">Helios</span>
        </h1>
        <p className="product-chooser__lede">Where do you want to go?</p>

        <div className="product-chooser__actions">
          <Link href="/dashboards" className="login-page__cta product-chooser__cta">
            Dashboards
          </Link>
          <Link href="/hub" className="login-page__cta product-chooser__cta">
            Outreach Hub
          </Link>
        </div>

        <p className="product-chooser__meta">
          <span>{email}</span>
          <button
            type="button"
            className="product-chooser__signout"
            onClick={() => void signOut({ callbackUrl: '/' })}
          >
            Sign out
          </button>
        </p>
      </section>
    </div>
  );
}
