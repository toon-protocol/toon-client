import { useEffect, useMemo, useRef, useState } from 'react';
import { useRelay } from './use-relay.js';
import { useRigConfig } from './use-rig-config.js';
import { parseRepoRefs } from '../nip34-parsers.js';
import type { RepoMetadata, RepoRefs, NostrFilter } from '../nip34-parsers.js';
import { resolveDefaultRef } from '../ref-resolver.js';
import { resolveGitSha, fetchArweaveObject } from '../arweave-client.js';
import { seedFromRefs } from '@/lib/seed-cache';
import { parseGitCommit, parseGitTree } from '../git-objects.js';
import type { TreeEntry } from '../git-objects.js';
import { pickPrimaryLanguage } from '@/lib/languages';
import type { Language } from '@/lib/languages';

/**
 * Total git-tree object fetches (root tree + subdirectories) budgeted per
 * repo when guessing its primary language. Keeps a repo with a huge or deep
 * tree from hammering the Arweave gateways just to paint a language badge.
 */
const MAX_TREE_FETCHES_PER_REPO = 6;

/**
 * How deep to walk the tree: 1 = root tree only, 2 = root + its immediate
 * subdirectories. Deep enough to see real source directories (`src/`,
 * `lib/`, …) without walking the whole repo.
 */
const MAX_TREE_DEPTH = 2;

function repoKey(ownerPubkey: string, repoId: string): string {
  return `${ownerPubkey}/${repoId}`;
}

/**
 * Resolve one repo's primary language: default ref -> tip commit -> tree,
 * walking to {@link MAX_TREE_DEPTH} and stopping once
 * {@link MAX_TREE_FETCHES_PER_REPO} tree fetches have been spent.
 *
 * Never throws: any failure along the way (unresolvable ref, missing
 * Arweave mapping, gateway miss, malformed object) simply yields `null`,
 * meaning "no language badge for this repo" rather than an error.
 */
async function resolveRepoLanguage(
  metadata: RepoMetadata,
  refs: RepoRefs
): Promise<Language | null> {
  const resolved = resolveDefaultRef(metadata, refs);
  if (!resolved) return null;

  // Seed the sha->txId cache from the refs' `arweave` map (kind:30618) so
  // resolveGitSha resolves from known object mappings instead of falling back
  // to a slow/empty Arweave GraphQL Git-SHA lookup — the same priming
  // repo-home-page does before it walks a tree.
  if (refs.arweaveMap?.size) seedFromRefs(refs, metadata.repoId);

  const commitTxId = await resolveGitSha(resolved.commitSha, metadata.repoId);
  if (!commitTxId) return null;
  const commitData = await fetchArweaveObject(commitTxId);
  if (!commitData) return null;
  const commit = parseGitCommit(commitData);
  if (!commit) return null;

  const fileNames: string[] = [];
  let fetchCount = 0;

  async function walkTree(sha: string, depth: number): Promise<void> {
    if (fetchCount >= MAX_TREE_FETCHES_PER_REPO) return;
    fetchCount += 1;

    const txId = await resolveGitSha(sha, metadata.repoId);
    if (!txId) return;
    const data = await fetchArweaveObject(txId);
    if (!data) return;

    const entries: TreeEntry[] = parseGitTree(data);
    const subdirs: TreeEntry[] = [];
    for (const entry of entries) {
      if (entry.mode === '40000') {
        if (depth < MAX_TREE_DEPTH) subdirs.push(entry);
      } else {
        // Files, gitlinks (160000), and symlinks (120000) are all fine as a
        // naming signal — only real subdirectories get walked further.
        fileNames.push(entry.name);
      }
    }

    if (depth >= MAX_TREE_DEPTH) return;
    for (const dir of subdirs) {
      if (fetchCount >= MAX_TREE_FETCHES_PER_REPO) break;
      await walkTree(dir.sha, depth + 1);
    }
  }

  await walkTree(commit.treeSha, 1);

  return pickPrimaryLanguage(fileNames);
}

/**
 * Resolves each repo's dominant language progressively: it returns
 * immediately with whatever has resolved so far and re-renders as more
 * repos finish resolving. Never blocks the repo-list page.
 *
 * @param repos - repo-list entries (each needs `ownerPubkey`, `repoId`,
 *   `defaultBranch`).
 * @returns a Map keyed by `${ownerPubkey}/${repoId}`, filled in over time.
 *   A repo missing from the Map either hasn't resolved yet, has no kind:30618
 *   refs on this relay, or its tree/commit objects aren't (yet) reachable on
 *   Arweave — never an error.
 */
export function useRepoLanguages(repos: RepoMetadata[]): Map<string, Language> {
  const { relayUrl } = useRigConfig();
  const [languages, setLanguages] = useState<Map<string, Language>>(new Map());

  // A stable, order-independent identity for "this exact set of repos at
  // these branches" — repo-list re-renders may hand us a new array
  // reference every time even when nothing meaningful changed, so effects
  // below key off this string instead of `repos` itself.
  const reposKey = useMemo(
    () =>
      repos
        .map((r) => `${r.ownerPubkey}:${r.repoId}:${r.defaultBranch}`)
        .sort()
        .join('|'),
    [repos]
  );

  const uniqueOwners = useMemo(() => {
    const seen = new Set<string>();
    for (const r of repos) seen.add(r.ownerPubkey);
    return Array.from(seen).sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on reposKey, not `repos` identity
  }, [reposKey]);

  const refsFilter = useMemo<NostrFilter | null>(() => {
    if (uniqueOwners.length === 0) return null;
    return { kinds: [30618], authors: uniqueOwners, limit: 500 };
  }, [uniqueOwners]);

  const { events } = useRelay(relayUrl, refsFilter);

  // Repo key -> its parsed refs, for repos that actually have a matching
  // kind:30618 event on this relay (matched by owner pubkey + `d` tag).
  const refsByRepo = useMemo(() => {
    const map = new Map<string, RepoRefs>();
    if (repos.length === 0) return map;

    const parsedByKey = new Map<string, RepoRefs>();
    for (const ev of events) {
      const parsed = parseRepoRefs(ev);
      if (!parsed) continue;
      parsedByKey.set(repoKey(ev.pubkey, parsed.repoId), parsed);
    }

    for (const repo of repos) {
      const key = repoKey(repo.ownerPubkey, repo.repoId);
      const refs = parsedByKey.get(key);
      if (refs) map.set(key, refs);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on reposKey, not `repos` identity
  }, [events, reposKey]);

  // Keys we've already started (or finished) resolving, whether it landed a
  // language or not — prevents duplicate in-flight fetches across re-renders
  // and re-tries of repos that already came up empty.
  const attemptedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    for (const repo of repos) {
      const key = repoKey(repo.ownerPubkey, repo.repoId);
      if (attemptedRef.current.has(key)) continue;

      const refs = refsByRepo.get(key);
      if (!refs) continue; // no refs (yet) — leave unattempted so it can retry later

      attemptedRef.current.add(key);

      resolveRepoLanguage(repo, refs)
        .then((language) => {
          if (cancelled || !language) return;
          setLanguages((prev) => {
            if (prev.has(key)) return prev;
            const next = new Map(prev);
            next.set(key, language);
            return next;
          });
        })
        .catch(() => {
          // Tolerate per-repo failures silently — no language badge, no crash.
        });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on reposKey, not `repos` identity
  }, [refsByRepo, reposKey]);

  return languages;
}
