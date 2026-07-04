import { Outlet, Link, useParams, useNavigate, useLocation } from 'react-router';
import { useRepo } from '@/hooks/use-repo';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { hexToNpub } from '../npub.js';
import { resolveDefaultRef } from '../ref-resolver.js';
import { shortRefName } from '@/lib/ref-utils';
import { ErrorBoundary } from '@/components/error-boundary';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useEffect, useMemo } from 'react';
import type { RepoMetadata, RepoRefs } from '../nip34-parsers.js';

export function RepoLayout() {
  const { owner = '', repo = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { metadata, refs, loading, error } = useRepo(owner, repo);
  const { getDisplayName, requestProfiles } = useProfileCache();

  useEffect(() => {
    if (metadata) {
      requestProfiles([metadata.ownerPubkey]);
    }
  }, [metadata, requestProfiles]);

  const activeTab = useMemo(() => {
    const path = location.pathname;
    if (path.includes('/issues')) return 'issues';
    if (path.includes('/pulls')) return 'pulls';
    if (path.includes('/commit')) return 'commits';
    return 'code';
  }, [location.pathname]);

  if (error) {
    return <div className="text-destructive-foreground">Failed to load repository: {error.message}</div>;
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (!metadata) {
    return <div className="text-muted-foreground">Repository not found.</div>;
  }

  const ownerDisplay = getDisplayName(metadata.ownerPubkey);
  const ownerNpub = metadata.ownerPubkey.length === 64
    ? hexToNpub(metadata.ownerPubkey)
    : owner;

  const handleTabChange = (value: string) => {
    const base = `/${ownerNpub}/${repo}`;
    switch (value) {
      case 'code':
        navigate(base);
        break;
      case 'issues':
        navigate(`${base}/issues`);
        break;
      case 'pulls':
        navigate(`${base}/pulls`);
        break;
      case 'commits': {
        const resolved = refs ? resolveDefaultRef(metadata, refs) : null;
        const branch = resolved ? shortRefName(resolved.refName) : metadata.defaultBranch;
        navigate(`${base}/commits/${branch}`);
      }
        break;
    }
  };

  return (
    <div className="space-y-4">
      {/* Repo header — repo glyph, owner/name breadcrumb, visibility pill, and
          the GitHub-style Watch / Fork / Star action cluster on the right. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-xl">
          <svg
            className="h-5 w-5 shrink-0 text-muted-foreground"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
          </svg>
          <Link to={`/${ownerNpub}`} className="text-primary hover:underline">
            {ownerDisplay}
          </Link>
          <span className="text-muted-foreground">/</span>
          <Link to={`/${ownerNpub}/${repo}`} className="font-semibold text-primary hover:underline">
            {metadata.name}
          </Link>
          <Badge variant="outline" className="ml-1 rounded-full text-xs font-medium text-muted-foreground">
            Public
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <RepoCounterButton
            label="Watch"
            count={0}
            icon="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.831.88 9.577.43 8.899a1.62 1.62 0 0 1 0-1.798c.45-.678 1.367-1.932 2.637-3.023C4.33 2.992 6.019 2 8 2ZM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"
          />
          <RepoCounterButton
            label="Fork"
            count={0}
            icon="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"
          />
          <RepoCounterButton
            label="Star"
            count={0}
            icon="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"
          />
        </div>
      </div>

      {metadata.description && (
        <p className="-mt-2 text-sm text-muted-foreground">{metadata.description}</p>
      )}

      {/* GitHub-style tab navigation */}
      <nav className="flex items-center gap-1 border-b">
        {([
          { key: 'code', label: 'Code', icon: 'M4.72 3.22a.75.75 0 011.06 1.06L2.06 8l3.72 3.72a.75.75 0 11-1.06 1.06L.47 8.53a.75.75 0 010-1.06l4.25-4.25zm6.56 0a.75.75 0 10-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 101.06 1.06l4.25-4.25a.75.75 0 000-1.06L11.28 3.22z' },
          { key: 'issues', label: 'Issues', icon: 'M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z' },
          { key: 'pulls', label: 'Pull Requests', icon: 'M1.5 3.25a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zm5.677-.177L9.573.677A.25.25 0 0110 .854V2.5h1A2.5 2.5 0 0113.5 5v5.628a2.251 2.251 0 11-1.5 0V5a1 1 0 00-1-1h-1v1.646a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm0 9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm8.25.75a.75.75 0 11-1.5 0 .75.75 0 011.5 0z' },
          { key: 'commits', label: 'Commits', icon: 'M11.93 8.5a4.002 4.002 0 01-7.86 0H.75a.75.75 0 010-1.5h3.32a4.002 4.002 0 017.86 0h3.32a.75.75 0 010 1.5h-3.32zm-1.43-.75a2.5 2.5 0 10-5 0 2.5 2.5 0 005 0z' },
        ] as const).map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => handleTabChange(key)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              activeTab === key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground'
            }`}
          >
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d={icon} />
            </svg>
            {label}
          </button>
        ))}
      </nav>

      {/* Per-tab error boundary: a crash in one tab renders an inline error
          card instead of white-screening the app; keyed on pathname so
          navigating to another tab resets it (#277). */}
      <ErrorBoundary key={location.pathname}>
        <Outlet context={{ metadata, refs, owner: ownerNpub, repo } satisfies RepoContext} />
      </ErrorBoundary>
    </div>
  );
}

export interface RepoContext {
  metadata: RepoMetadata;
  refs: RepoRefs | null;
  owner: string;
  repo: string;
}

/**
 * GitHub's split "counter" button (Watch / Fork / Star): a labeled action
 * segment joined to a count segment. These are presentational for now — the
 * decentralized model has no server-side engagement metric to back them — so
 * they render disabled to avoid implying a working control.
 */
function RepoCounterButton({
  label,
  count,
  icon,
}: {
  label: string;
  count: number;
  icon: string;
}) {
  return (
    <div className="inline-flex items-stretch overflow-hidden rounded-md border text-xs font-medium">
      <span className="flex items-center gap-1.5 bg-secondary px-2.5 py-1 text-secondary-foreground">
        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d={icon} />
        </svg>
        {label}
      </span>
      <span className="flex items-center border-l bg-background px-2.5 py-1 tabular-nums text-muted-foreground">
        {count}
      </span>
    </div>
  );
}
