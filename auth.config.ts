import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';

/**
 * Edge-safe Auth.js config (no Node/pg imports).
 * Used by middleware. Full callbacks with DB live in auth.ts.
 */
export const authConfig = {
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          hd: 'heliosgroup.ai',
          prompt: 'select_account',
        },
      },
    }),
  ],
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/',
    error: '/',
  },
  trustHost: true,
} satisfies NextAuthConfig;
