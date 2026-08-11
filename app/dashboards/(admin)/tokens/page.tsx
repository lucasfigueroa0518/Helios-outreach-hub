import AddTokenForm from '@/components/dashboards/admin/AddTokenForm';
import TokenList from '@/components/dashboards/admin/TokenList';
import { listGithubTokenMeta } from '@/lib/dashboards/repository';

export const dynamic = 'force-dynamic';

export default async function TokensPage({
  searchParams,
}: {
  searchParams: Promise<{ prefill?: string }>;
}) {
  const { prefill } = await searchParams;
  const tokens = await listGithubTokenMeta();

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight text-fg-1">
          GitHub tokens
        </h1>
        <p className="mt-1 text-sm font-light text-fg-3">
          Per-owner PATs, encrypted at rest. Sync resolves the token from the
          repo owner handle.
        </p>
      </div>

      <AddTokenForm prefillHandle={prefill ?? ''} />

      <TokenList
        tokens={tokens.map((t) => ({
          id: t.id,
          githubHandle: t.githubHandle,
          tokenSuffix: t.tokenSuffix,
          addedByEmail: t.addedByEmail,
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
          expiresAt: t.expiresAt?.toISOString() ?? null,
          createdAt: t.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
