import { useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { useRepoList } from '@/hooks/use-repo-list';
import { useRepoIssueCounts } from '@/hooks/use-repo-issue-counts';
import { useRepoLanguages } from '@/hooks/use-repo-languages';
import { hexToNpub, npubToHex, truncateNpubFromHex } from '../../npub.js';
import { formatRelativeDate } from '../../date-utils.js';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

/** Give a bare-host website a scheme so the anchor doesn't resolve relative. */
function externalHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * A user/owner profile — the bare `#/<npub>` route. Renders the author's
 * kind:0 metadata (avatar, name, bio, nip05, website) alongside the
 * repositories they've published, GitHub user-page style.
 */
export function ProfilePage() {
  const { owner = '' } = useParams();
  const { getDisplayName, getProfile, requestProfiles } = useProfileCache();

  const pubkeyHex = useMemo(() => {
    try {
      return owner.startsWith('npub1') ? npubToHex(owner) : owner;
    } catch {
      return null;
    }
  }, [owner]);

  useEffect(() => {
    if (pubkeyHex) requestProfiles([pubkeyHex]);
  }, [pubkeyHex, requestProfiles]);

  const { repos, loading, error } = useRepoList(pubkeyHex ?? undefined);
  const { counts: issueCounts } = useRepoIssueCounts(repos);
  const languages = useRepoLanguages(repos);

  if (!pubkeyHex) {
    return <div className="text-muted-foreground">Invalid profile identifier.</div>;
  }

  const profile = getProfile(pubkeyHex);
  const displayName = getDisplayName(pubkeyHex);
  const npub = hexToNpub(pubkeyHex);
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <div className="flex flex-col gap-8 lg:flex-row">
      {/* Profile sidebar */}
      <aside className="space-y-4 lg:w-80 lg:shrink-0">
        <Avatar className="h-40 w-40 border">
          {profile?.picture && <AvatarImage src={profile.picture} alt={displayName} />}
          <AvatarFallback className="text-4xl">{initials}</AvatarFallback>
        </Avatar>

        <div>
          <h1 className="text-2xl font-bold leading-tight">{displayName}</h1>
          {profile?.name && profile.name !== displayName && (
            <p className="text-lg text-muted-foreground">{profile.name}</p>
          )}
        </div>

        {profile?.about && (
          <p className="whitespace-pre-wrap text-sm">{profile.about}</p>
        )}

        <div className="space-y-1.5 text-sm text-muted-foreground">
          {profile?.nip05 && (
            <div className="flex items-center gap-2">
              <svg className="h-4 w-4 shrink-0 text-[--success]" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M9.585.52a2.678 2.678 0 0 0-3.17 0l-.928.68a1.178 1.178 0 0 1-.518.215l-1.138.175a2.678 2.678 0 0 0-2.24 2.24l-.175 1.14a1.178 1.178 0 0 1-.215.518l-.68.928a2.678 2.678 0 0 0 0 3.17l.68.928c.113.153.186.33.215.518l.175 1.138a2.678 2.678 0 0 0 2.24 2.24l1.138.175c.187.029.365.102.518.215l.928.68a2.678 2.678 0 0 0 3.17 0l.928-.68c.153-.113.33-.186.518-.215l1.138-.175a2.678 2.678 0 0 0 2.241-2.241l.175-1.138c.029-.187.102-.365.215-.518l.68-.928a2.678 2.678 0 0 0 0-3.17l-.68-.928a1.179 1.179 0 0 1-.215-.518L14.41 3.83a2.678 2.678 0 0 0-2.24-2.24l-1.138-.175a1.179 1.179 0 0 1-.518-.215L9.585.52ZM11.28 6.78l-3.75 3.75a.75.75 0 0 1-1.06 0L4.72 8.78a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L7 8.94l3.22-3.22a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z" />
              </svg>
              <span className="truncate">{profile.nip05.replace(/^_@/, '')}</span>
            </div>
          )}
          {profile?.website && (
            <a
              href={externalHref(profile.website)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 hover:text-foreground"
            >
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25Zm-4.69 9.64a2 2 0 0 1 0-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25a.75.75 0 0 0-1.06-1.06l-1.25 1.25a2 2 0 0 1-2.83 0Z" />
              </svg>
              <span className="truncate">{profile.website.replace(/^https?:\/\//i, '')}</span>
            </a>
          )}
          <div className="flex items-center gap-2 pt-1 font-mono text-xs">
            <svg className="h-4 w-4 shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M10.5 6a2.5 2.5 0 1 0-2.45 2.5H8.5a.75.75 0 0 1 .75.75v.75h.75a.75.75 0 0 1 .75.75v.75h.75a.75.75 0 0 1 .53.22l.72.72a.75.75 0 0 1-1.06 1.06l-.5-.5H10.5a.75.75 0 0 1-.75-.75v-.75H9a.75.75 0 0 1-.75-.75v-.06A2.5 2.5 0 0 0 10.5 6Zm-3 0a1 1 0 1 1 2 0 1 1 0 0 1-2 0Z" />
            </svg>
            <span className="truncate" title={npub}>{truncateNpubFromHex(pubkeyHex)}</span>
          </div>
        </div>
      </aside>

      {/* Repositories */}
      <div className="min-w-0 flex-1 space-y-4">
        <h2 className="flex items-baseline gap-2 border-b pb-2 text-lg font-semibold">
          Repositories
          {repos.length > 0 && (
            <span className="rounded-full border px-2 text-xs font-normal text-muted-foreground">
              {repos.length}
            </span>
          )}
        </h2>

        {error ? (
          <div className="text-destructive-foreground">Failed to load repositories: {error.message}</div>
        ) : loading ? (
          <div className="divide-y rounded-md border">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="space-y-2 p-4">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-72" />
              </div>
            ))}
          </div>
        ) : repos.length === 0 ? (
          <p className="py-8 text-sm text-muted-foreground">
            This user hasn’t published any repositories yet.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {repos.map((repo) => {
              const repoKey = `${repo.ownerPubkey}/${repo.repoId}`;
              const language = languages.get(repoKey);
              const openIssues = issueCounts.get(repoKey) ?? 0;
              return (
                <li key={repoKey} className="px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/${npub}/${repo.repoId}`}
                      className="text-base font-semibold text-primary hover:underline"
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
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{repo.description}</p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
                        to={`/${npub}/${repo.repoId}/issues`}
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
                    <span>Updated {formatRelativeDate(repo.announcedAt)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
