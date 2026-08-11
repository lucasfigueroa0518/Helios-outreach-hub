'use client';

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

      <section className="login-page__stage product-chooser__stage" aria-label="Helios home">
        <h1 className="login-page__brand">
          <span className="login-page__brand-line">Helios</span>
        </h1>
        <p className="product-chooser__lede">
          Open the menu to jump into Outreach or Project Dashboards.
        </p>

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
