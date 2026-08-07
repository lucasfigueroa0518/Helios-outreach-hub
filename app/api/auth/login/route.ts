import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/** Passwordless email login is retired — use Google via Auth.js. */
export async function POST() {
  return NextResponse.json(
    {
      error: 'Passwordless email login is disabled. Sign in with Google at /.',
      code: 'passwordless_retired',
    },
    { status: 410 },
  );
}
