# Google OAuth setup (Helios Auth.js)

Free Google sign-in for `@heliosgroup.ai` only. Auth.js enforces the domain allowlist in code (`ALLOWED_EMAIL_DOMAINS=heliosgroup.ai`).

## 1. Google Cloud Console

1. Open [Google Cloud Console](https://console.cloud.google.com/) → select or create a project.
2. **APIs & Services → OAuth consent screen**
   - User type: **Internal** if every user is in the Helios Google Workspace org; otherwise **External** (allowlist still blocks non-Helios emails).
   - App name: Helios Outreach Hub (or similar).
   - Support email: your `@heliosgroup.ai` address.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized JavaScript origins (optional but useful):
     - `http://localhost:3000`
     - `https://<your-production-host>`
   - Authorized redirect URIs (required):
     - `http://localhost:3000/api/auth/callback/google`
     - `https://<your-production-host>/api/auth/callback/google`
4. Copy **Client ID** and **Client secret**.

## 2. App env

In `.env.local` (and Vercel for production):

```bash
AUTH_SECRET=<openssl rand -base64 32>
AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=<from Google>
GOOGLE_CLIENT_SECRET=<from Google>
ALLOWED_EMAIL_DOMAINS=heliosgroup.ai
```

Production: set `AUTH_URL` to the public site URL (or rely on `trustHost` + the request host).

## 3. Verify

1. `npm run dev` → open `/`
2. **Continue with Google** with a `@heliosgroup.ai` account → land on `/hub`
3. Sign out, try a personal Gmail → access denied / clear error
4. Hit `/api/webhooks/resend` without a session → still accepted by middleware (signature checked in the route)

## Notes

- `hd=heliosgroup.ai` is a Google account-picker hint only; the server allowlist is the real gate.
- Passwordless `POST /api/auth/login` returns **410** and cannot mint sessions.
