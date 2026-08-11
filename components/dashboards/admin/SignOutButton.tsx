'use client';

import { signOut } from 'next-auth/react';

export default function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => void signOut({ callbackUrl: '/' })}
      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg-2 hover:border-border hover:bg-bg-alt transition-colors"
    >
      Sign out
    </button>
  );
}
