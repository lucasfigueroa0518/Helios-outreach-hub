import { Suspense } from 'react';

import { LoginForm } from '@/app/login-form';

export default function LoginPage() {
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
