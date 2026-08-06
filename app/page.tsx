'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => {
        if (r.ok) router.replace('/hub');
        else setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      let data: { error?: string } = {};
      try {
        data = await res.json();
      } catch {
        setError(`Sign-in failed (${res.status})`);
        return;
      }
      if (!res.ok) {
        setError(data.error ?? 'Sign-in failed');
        return;
      }
      router.replace('/hub');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error — try again.');
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <main className="app-shell app-shell--centered">
        <p className="text-muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="app-shell app-shell--centered">
      <section className="card login-card">
        <div className="card__header login-card__header">
          <div>
            <div className="card__title">Outreach Hub</div>
            <div className="card__subtitle">Enter your email to continue</div>
          </div>
        </div>
        <div className="card__body">
          <form className="login-form" onSubmit={onSubmit}>
            <label className="field">
              <span className="field__label">Email</span>
              <input
                className="field__input"
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            {error && <p className="field__error">{error}</p>}
            <button className="btn btn--primary" type="submit" disabled={loading}>
              {loading ? 'Signing in…' : 'Continue'}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
