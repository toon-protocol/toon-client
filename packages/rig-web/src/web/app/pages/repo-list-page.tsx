import { useEffect } from 'react';
import { Link } from 'react-router';
import { useRepoList } from '@/hooks/use-repo-list';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { useRigConfig } from '@/hooks/use-rig-config';
import { hexToNpub } from '../../npub.js';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';

export function RepoListPage() {
  const { repos, loading, error } = useRepoList();
  const { getDisplayName, requestProfiles } = useProfileCache();
  const { relayUrl } = useRigConfig();

  useEffect(() => {
    if (repos.length > 0) {
      requestProfiles(repos.map((r) => r.ownerPubkey));
    }
  }, [repos, requestProfiles]);

  if (error) {
    return <div className="text-destructive-foreground">Failed to load repositories: {error.message}</div>;
  }

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-32 rounded-lg" />
        ))}
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
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {repos.map((repo) => {
        const ownerNpub = hexToNpub(repo.ownerPubkey);
        return (
          <Link
            key={repo.eventId}
            to={`/${ownerNpub}/${repo.repoId}`}
          >
            <Card className="h-full transition-colors hover:border-primary/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  <span className="text-muted-foreground">{getDisplayName(repo.ownerPubkey)}</span>
                  {' / '}
                  {repo.name}
                </CardTitle>
                {repo.description && (
                  <CardDescription className="line-clamp-2">
                    {repo.description}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {repo.defaultBranch}
              </CardContent>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}
