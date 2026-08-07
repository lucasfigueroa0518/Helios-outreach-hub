'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';

function errorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === 'AccessDenied' || code === 'Configuration' || code === 'SignIn') {
    return "This account isn't authorized to sign in.";
  }
  if (code === 'OAuthAccountNotLinked') {
    return 'That Google account could not be linked. Try another account.';
  }
  return 'Sign-in failed. Please try again.';
}

function GoogleMark() {
  return (
    <svg className="login-page__google" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" />
    </svg>
  );
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
    return (
      <div className="login-page">
        <div className="login-page__atmosphere" aria-hidden="true" />
        <p className="login-page__loading">Loading…</p>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-page__atmosphere" aria-hidden="true">
        <span className="login-page__orb login-page__orb--a" />
        <span className="login-page__orb login-page__orb--b" />
        <span className="login-page__orb login-page__orb--c" />
        <span className="login-page__grid" />
      </div>

      <section className="login-page__stage" aria-label="Sign in">
        <h1 className="login-page__brand">
          <span className="login-page__brand-line">Helios</span>
          <span className="login-page__brand-line">Outreach Hub</span>
        </h1>

        {error ? <p className="login-page__error" role="alert">{error}</p> : null}

        <button
          className="login-page__cta"
          type="button"
          disabled={loading}
          onClick={() => void continueWithGoogle()}
        >
          <GoogleMark />
          {loading ? 'Redirecting…' : 'Sign in with Google'}
        </button>
      </section>
    </div>
  );
}
