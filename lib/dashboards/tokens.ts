import { decryptToken } from '@/lib/dashboards/crypto';
import {
  findGithubTokenByHandle,
  touchGithubTokenLastUsed,
} from '@/lib/dashboards/repository';

/**
 * Resolve a decrypted GitHub PAT for a repo slug `owner/repo`.
 * Decrypts only in server/worker memory — never return this to the client.
 */
export async function getTokenForRepo(githubRepo: string): Promise<string | null> {
  const owner = githubRepo.split('/')[0]?.trim();
  if (!owner) return null;

  const row = await findGithubTokenByHandle(owner);
  if (!row) {
    // Bootstrap fallback for migrate/dev only — not the long-term model.
    const envToken = process.env.GITHUB_TOKEN?.trim();
    if (envToken) return envToken;
    return null;
  }

  void touchGithubTokenLastUsed(row.id);
  return decryptToken(row.encrypted_token, row.iv, row.auth_tag);
}

export const PAT_FORMAT_RE = /^(github_pat_|ghp_)[A-Za-z0-9_]+$/;

export function maskPatSuffix(suffix: string): string {
  return `••••${suffix}`;
}
