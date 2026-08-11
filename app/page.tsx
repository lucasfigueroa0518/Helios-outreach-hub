import { Suspense } from 'react';

import { LoginForm } from '@/app/login-form';
import { ProductChooser } from '@/app/product-chooser';
import { getSession } from '@/lib/session';

export default async function HomePage() {
  const session = await getSession();

  if (session) {
    return <ProductChooser email={session.email} />;
  }

  return (
    <Suspense
      fallback={(
        <div className="login-page">
          <div className="login-page__atmosphere" aria-hidden="true" />
          <p className="login-page__loading">Loading…</p>
        </div>
      )}
    >
      <LoginForm />
    </Suspense>
  );
}
