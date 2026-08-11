import { GitBranch } from 'lucide-react';

export default function GitHubEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-border py-14 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-bg-alt">
        <GitBranch className="h-6 w-6 text-fg-muted" />
      </div>
      <p className="text-sm font-semibold text-fg-2">Activity Coming Soon</p>
      <p className="mt-1.5 max-w-xs text-xs font-light leading-relaxed text-fg-muted">
        Repository activity will appear here once your project is connected.
      </p>
    </div>
  );
}
