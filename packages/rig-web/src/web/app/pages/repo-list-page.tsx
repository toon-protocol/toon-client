import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useRepoList } from '@/hooks/use-repo-list';
import { useRepoIssueCounts } from '@/hooks/use-repo-issue-counts';
import { useRepoLanguages } from '@/hooks/use-repo-languages';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { useRigConfig } from '@/hooks/use-rig-config';
import { hexToNpub } from '../../npub.js';
import { formatRelativeDate } from '../../date-utils.js';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

export function RepoListPage() {
  const { repos, loading, error } = useRepoList();
  const { getDisplayName, requestProfiles } = useProfileCache();
  const { relayUrl } = useRigConfig();
  const [query, setQuery] = useState('');

  // Enrich each row with real, per-repo signals — resolved from the network
  // and filled in progressively (never blocking the list): the open-issue
  // count (one batched relay query over kind:1621/163x) and the primary
  // language (a bounded Arweave tree walk per repo, keyed `${owner}/${repoId}`).
  const { counts: issueCounts } = useRepoIssueCounts(repos);
  const languages = useRepoLanguages(repos);

  useEffect(() => {
    if (repos.length > 0) {
      requestProfiles(repos.map((r) => r.ownerPubkey));
    }
  }, [repos, requestProfiles]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        getDisplayName(r.ownerPubkey).toLowerCase().includes(q),
    );
  }, [repos, query, getDisplayName]);

  if (error) {
    return <div className="text-destructive-foreground">Failed to load repositories: {error.message}</div>;
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-full max-w-md" />
        <div className="divide-y rounded-md border">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="space-y-2 p-4">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-80" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <p>No repositories found.</p>
        <p className="mt-1 text-xs">Check that your relay is running at {relayUrl}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Repositories</h1>

      {/* Client-side filter over the already-loaded announcements — real,
          functional (there is no server-side repo search on the relay). */}
      <div className="relative max-w-full">
        <svg
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search repositories…"
          aria-label="Search repositories"
          className="w-full rounded-md border bg-background py-1.5 pl-9 pr-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>

      <div className="rounded-md border">
        <div className="border-b bg-muted/40 px-4 py-2.5 text-sm font-semibold">
          {filtered.length} {filtered.length === 1 ? 'repository' : 'repositories'}
        </div>
        <ul className="divide-y">
          {filtered.map((repo) => {
            const ownerNpub = hexToNpub(repo.ownerPubkey);
            const repoKey = `${repo.ownerPubkey}/${repo.repoId}`;
            const language = languages.get(repoKey);
            const openIssues = issueCounts.get(repoKey) ?? 0;
            return (
              <li
                key={`${repo.ownerPubkey}/${repo.repoId}`}
                className="flex items-start justify-between gap-4 px-4 py-4"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/${ownerNpub}/${repo.repoId}`}
                      className="text-lg font-semibold text-primary hover:underline"
                    >
                      {repo.name}
                    </Link>
                    <Badge
                      variant="outline"
                      className="rounded-full text-xs font-medium text-muted-foreground"
                    >
                      Public
                    </Badge>
                  </div>
                  {repo.description && (
                    <p className="line-clamp-2 text-sm text-muted-foreground">{repo.description}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
                    <Link to={`/${ownerNpub}`} className="hover:text-foreground hover:underline">
                      {getDisplayName(repo.ownerPubkey)}
                    </Link>
                    {language && (
                      <span className="flex items-center gap-1">
                        <span
                          className="h-3 w-3 rounded-full"
                          style={{ backgroundColor: language.color }}
                          aria-hidden="true"
                        />
                        {language.name}
                      </span>
                    )}
                    {openIssues > 0 && (
                      <Link
                        to={`/${ownerNpub}/${repo.repoId}/issues`}
                        className="flex items-center gap-1 hover:text-foreground"
                        title={`${openIssues} open issue${openIssues === 1 ? '' : 's'}`}
                      >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                          <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
                          <path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
                        </svg>
                        {openIssues}
                      </Link>
                    )}
                    {repo.announcedAt ? (
                      <span>Updated {formatRelativeDate(repo.announcedAt)}</span>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
          {filtered.length === 0 && (
            <li className="px-4 py-8 text-center text-sm text-muted-foreground">
              No repositories match “{query}”.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
