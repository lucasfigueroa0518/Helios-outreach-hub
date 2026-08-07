import NextAuth from 'next-auth';

import { authConfig } from '@/auth.config';
import { upsertUserByEmail } from '@/lib/auth';
import {
  isAllowedLoginEmail,
  isOpenAllowlistForbidden,
} from '@/lib/login-policy';

function googleEmailVerified(profile: { email_verified?: boolean | string } | undefined): boolean {
  return profile?.email_verified === true || profile?.email_verified === 'true';
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    async signIn({ profile, user }) {
      if (isOpenAllowlistForbidden()) return false;
      const email = (profile?.email ?? user.email)?.trim().toLowerCase();
      if (!email || !googleEmailVerified(profile as { email_verified?: boolean | string })) {
        return false;
      }
      if (!isAllowedLoginEmail(email)) return false;
      await upsertUserByEmail(email);
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
