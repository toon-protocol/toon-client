/** Forge atoms — NIP-34 repo, issue, PR, comment thread (read). */
import { type FC } from 'react';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { MonoId } from '@/components/mono-id.js';
import {
  parseRepoAnnouncement,
  parseIssue,
  parsePR,
  parseComment,
  type CommentMetadata,
} from '../parsers/nip34.js';
import { type Atom, type AtomRenderProps } from './types.js';

const RepoCard: FC<AtomRenderProps> = ({ events }) => {
  const repo = events.map(parseRepoAnnouncement).find((r) => r !== null) ?? null;
  if (!repo) return null;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">{repo.name}</span>
        <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
          {repo.defaultBranch}
        </Badge>
      </div>
      {repo.description ? (
        <p className="mt-1 text-sm text-muted-foreground">{repo.description}</p>
      ) : null}
    </div>
  );
};

const IssueCard: FC<AtomRenderProps> = ({ events, actions }) => {
  const issue = events.map(parseIssue).find((i) => i !== null) ?? null;
  if (!issue) return null;
  return (
    <div className="flex flex-col gap-1.5 border-b border-border py-3 first:pt-0 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-sm">{issue.title}</span>
        {issue.labels.map((l) => (
          <Badge key={l} variant="secondary" className="text-[10px]">{l}</Badge>
        ))}
      </div>
      {issue.content ? (
        <p className="line-clamp-2 text-sm text-muted-foreground">{issue.content}</p>
      ) : null}
      {actions['comment'] ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start h-6 px-0 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => void actions['comment']?.({ parentId: issue.eventId })}
        >
          Comment
        </Button>
      ) : null}
    </div>
  );
};

const PRCard: FC<AtomRenderProps> = ({ events }) => {
  const pr = events.map(parsePR).find((p) => p !== null) ?? null;
  if (!pr) return null;
  return (
    <div className="flex flex-col gap-1.5 border-b border-border py-3 first:pt-0 last:border-0 last:pb-0">
      <div className="flex items-center gap-2">
        <Badge variant={pr.status === 'open' ? 'default' : 'secondary'} className="uppercase text-[10px]">
          {pr.status}
        </Badge>
        <span className="font-medium text-sm">{pr.title || '(untitled patch)'}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        {pr.commitShas.length} commit{pr.commitShas.length !== 1 ? 's' : ''} → {pr.baseBranch}
      </div>
    </div>
  );
};

const CommentThread: FC<AtomRenderProps> = ({ events, actions }) => {
  const comments: CommentMetadata[] = events
    .map(parseComment)
    .filter((c): c is CommentMetadata => c !== null)
    .sort((a, b) => a.createdAt - b.createdAt);
  return (
    <div className="flex flex-col gap-2">
      {comments.map((c) => (
        <div key={c.eventId} className="rounded-md border border-border bg-card p-3">
          <div className="mb-1.5">
            <MonoId value={c.authorPubkey} className="text-muted-foreground" />
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{c.content}</p>
        </div>
      ))}
      {actions['comment'] ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start h-6 px-0 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => void actions['comment']?.()}
        >
          Add comment
        </Button>
      ) : null}
    </div>
  );
};

export const forgeAtoms: Atom[] = [
  { id: 'repo-card', kinds: [30617], Component: RepoCard },
  {
    id: 'issue-card',
    kinds: [1621],
    writes: [{ name: 'toon_publish_unsigned' }],
    Component: IssueCard,
  },
  { id: 'pr-card', kinds: [1617], Component: PRCard },
  {
    id: 'comment-thread',
    kinds: [1622],
    writes: [{ name: 'toon_publish_unsigned' }],
    Component: CommentThread,
  },
];
