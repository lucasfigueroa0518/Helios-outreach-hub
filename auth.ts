import NextAuth from 'next-auth';

import { authConfig } from '@/auth.config';
import { upsertUserByEmail } from '@/lib/auth';
import {
  isAllowedLoginEmail,
  isOpenAllowlistForbidden,
  parseAllowedEmailDomains,
} from '@/lib/login-policy';

function googleEmailVerified(profile: {
  email_verified?: boolean | string;
} | undefined): boolean {
  // Google OAuth profiles should include email_verified. Some Auth.js shapes omit it
  // after normalization — treat explicit false as the only hard reject.
  if (profile?.email_verified === false || profile?.email_verified === 'false') {
    return false;
  }
  return true;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    async signIn({ profile, user, account }) {
      if (isOpenAllowlistForbidden()) {
        console.error('[auth] AccessDenied: ALLOWED_EMAIL_DOMAINS missing/open in production', {
          parsed: parseAllowedEmailDomains(),
        });
        return false;
      }
      const email = (profile?.email ?? user.email)?.trim().toLowerCase();
      if (!email) {
        console.error('[auth] AccessDenied: no email on Google profile/user');
        return false;
      }
      if (!googleEmailVerified(profile as { email_verified?: boolean | string })) {
        console.error('[auth] AccessDenied: Google email not verified', {
          domain: email.split('@')[1] ?? null,
          provider: account?.provider,
        });
        return false;
      }
      if (!isAllowedLoginEmail(email)) {
        console.error('[auth] AccessDenied: email domain not on allowlist', {
          domain: email.split('@')[1] ?? null,
          allowlist: parseAllowedEmailDomains(),
        });
        return false;
      }
      try {
        await upsertUserByEmail(email);
      } catch (error) {
        console.error('[auth] AccessDenied: upsertUserByEmail failed', {
          domain: email.split('@')[1] ?? null,
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      return true;
    },
    async jwt({ token, profile, user }) {
      const incomingEmail = (profile?.email ?? user?.email)?.trim().toLowerCase();
      if (incomingEmail && isAllowedLoginEmail(incomingEmail) && !isOpenAllowlistForbidden()) {
        const outreachUser = await upsertUserByEmail(incomingEmail);
        token.userId = outreachUser.id;
        token.email = outreachUser.email;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = typeof token.userId === 'string' ? token.userId : '';
        session.user.email = typeof token.email === 'string' ? token.email : session.user.email;
      }
      return session;
    },
  },
});
