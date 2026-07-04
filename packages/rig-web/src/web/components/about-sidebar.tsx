import { useEffect } from 'react';
import { Link } from 'react-router';
import { GitBranch, Tag as TagIcon, Radio } from 'lucide-react';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { useRigConfig } from '@/hooks/use-rig-config';
import { hexToNpub } from '../npub.js';
import type { RepoMetadata, RepoRefs } from '../nip34-parsers.js';

interface AboutSidebarProps {
  metadata: RepoMetadata;
  refs: RepoRefs | null;
  /** Owner param as already resolved by RepoLayout (npub, or raw param as a fallback). */
  owner: string;
}

/** hex pubkey → npub, tolerant of anything that isn't 64-char lowercase hex. */
function toNpub(pubkey: string): string {
  return /^[0-9a-f]{64}$/i.test(pubkey) ? hexToNpub(pubkey) : pubkey;
}

/**
 * GitHub-style "About" panel for the repo Code page's right column.
 *
 * Shows ONLY data the repo actually carries: the kind:30617 description, ref
 * counts derived from the kind:30618 refs map, the owner (+ declared
 * maintainers, #287) with profile display names, and the relay this UI is
 * reading from. There is no stars/topics/releases/language data on TOON, so
 * those GitHub panels are omitted rather than faked.
 */
export function AboutSidebar({ metadata, refs, owner }: AboutSidebarProps) {
  const { getDisplayName, requestProfiles } = useProfileCache();
  const { relayUrl } = useRigConfig();

  // RepoLayout already requests the owner's profile, but maintainers (#287)
  // aren't fetched anywhere else — request all of them here so their display
  // names resolve instead of falling back to truncated pubkeys.
  useEffect(() => {
    requestProfiles([metadata.ownerPubkey, ...metadata.maintainers]);
  }, [metadata.ownerPubkey, metadata.maintainers, requestProfiles]);

  const branchCount = refs
    ? [...refs.refs.keys()].filter((r) => r.startsWith('refs/heads/')).length
    : 0;
  const tagCount = refs
    ? [...refs.refs.keys()].filter((r) => r.startsWith('refs/tags/')).length
    : 0;

  const maintainers = metadata.maintainers;

  return (
    <aside className="w-full shrink-0 space-y-4 lg:w-72">
      <div>
        <h2 className="text-sm font-semibold">About</h2>
        {metadata.description ? (
          <p className="mt-2 text-sm text-muted-foreground">{metadata.description}</p>
        ) : (
          <p className="mt-2 text-sm italic text-muted-foreground">
            No description provided.
          </p>
        )}
      </div>

      <ul className="space-y-2 border-t pt-3 text-sm text-muted-foreground">
        <li className="flex items-center gap-2">
          <GitBranch aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span>
            {branchCount} branch{branchCount === 1 ? '' : 'es'}
          </span>
        </li>
        <li className="flex items-center gap-2">
          <TagIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span>
            {tagCount} tag{tagCount === 1 ? '' : 's'}
          </span>
        </li>
      </ul>

      <div className="border-t pt-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {maintainers.length > 0 ? 'Maintainers' : 'Owner'}
        </h3>
        <ul className="mt-2 space-y-1.5 text-sm">
          <li>
            <Link to={`/${owner}`} className="text-primary hover:underline">
              {getDisplayName(metadata.ownerPubkey)}
            </Link>
          </li>
          {maintainers.map((pubkey) => (
            <li key={pubkey}>
              <Link to={`/${toNpub(pubkey)}`} className="text-primary hover:underline">
                {getDisplayName(pubkey)}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
        <Radio aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate font-mono" title={relayUrl}>
          {relayUrl}
        </span>
      </div>
    </aside>
  );
}
