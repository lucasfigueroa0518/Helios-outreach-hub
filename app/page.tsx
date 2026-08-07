import { Suspense } from 'react';

import { LoginForm } from '@/app/login-form';

export default function LoginPage() {
  return (
    <main className="app-shell app-shell--centered">
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
