'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';

import { loginEmailPolicyMessage } from '@/lib/login-policy';

function errorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === 'AccessDenied' || code === 'Configuration' || code === 'SignIn') {
    return loginEmailPolicyMessage();
  }
  if (code === 'OAuthAccountNotLinked') {
    return 'That Google account could not be linked. Try again with your @heliosgroup.ai account.';
  }
  return 'Sign-in failed. Try again with your @heliosgroup.ai Google account.';
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const urlError = useMemo(
    () => errorMessage(searchParams.get('error')),
    [searchParams],
  );

  useEffect(() => {
    if (urlError) setError(urlError);
  }, [urlError]);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => {
        if (r.ok) router.replace('/hub');
        else setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [router]);

  async function continueWithGoogle() {
    setError(null);
    setLoading(true);
    try {
      await signIn('google', { callbackUrl: '/hub' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
      setLoading(false);
    }
  }

  if (checking) {
    return <p className="text-muted">Loading…</p>;
  }

  return (
    <section className="card login-card">
      <div className="card__header login-card__header">
        <div>
          <div className="card__title">Helios Outreach Hub</div>
          <div className="card__subtitle">
            Sign in with your @heliosgroup.ai Google account
          </div>
        </div>
      </div>
      <div className="card__body">
        <div className="login-form">
          {error ? <p className="field__error">{error}</p> : null}
          <button
            className="btn btn--primary"
            type="button"
            disabled={loading}
            onClick={() => void continueWithGoogle()}
          >
            {loading ? 'Redirecting to Google…' : 'Continue with Google'}
          </button>
        </div>
      </div>
    </section>
  );
}
