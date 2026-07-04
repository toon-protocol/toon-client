import { useEffect, useMemo } from 'react';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { formatRelativeDate } from '../date-utils.js';
import { renderMarkdownSafe } from '../markdown-safe.js';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import type { CommentMetadata } from '../nip34-parsers.js';

interface CommentThreadProps {
  /** The original issue/PR content rendered as the first "comment" */
  originalContent: string;
  originalAuthor: string;
  originalCreatedAt: number;
  comments: CommentMetadata[];
}

export function CommentThread({
  originalContent,
  originalAuthor,
  originalCreatedAt,
  comments,
}: CommentThreadProps) {
  const { getDisplayName, requestProfiles } = useProfileCache();

  const commentPubkeys = useMemo(
    () => comments.map((c) => c.authorPubkey).join(','),
    [comments],
  );

  useEffect(() => {
    const pubkeys = [originalAuthor, ...commentPubkeys.split(',').filter(Boolean)];
    requestProfiles(pubkeys);
  }, [originalAuthor, commentPubkeys, requestProfiles]);

  const allItems = [
    {
      content: originalContent,
      authorPubkey: originalAuthor,
      createdAt: originalCreatedAt,
      eventId: 'original',
    },
    ...comments,
  ];

  return (
    <div className="flex flex-col">
      {allItems.map((item, i) => {
        const displayName = getDisplayName(item.authorPubkey);
        const initials = displayName.slice(0, 2).toUpperCase();
        const html = renderMarkdownSafe(item.content);
        const isLast = i === allItems.length - 1;

        return (
          <div key={item.eventId} className="relative flex gap-3 pb-4">
            {!isLast && (
              <span
                aria-hidden="true"
                className="absolute top-8 bottom-0 left-4 w-px bg-border"
              />
            )}
            <Avatar className="relative z-10 h-8 w-8 shrink-0">
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1 rounded-md border">
              <div className="flex items-center gap-2 rounded-t-md border-b bg-muted px-3 py-2 text-sm">
                <span className="font-medium">{displayName}</span>
                <span className="text-muted-foreground">
                  commented {formatRelativeDate(item.createdAt)}
                </span>
              </div>
              <div className="bg-card px-4 py-3">
                <div
                  className="prose prose-sm max-w-none dark:prose-invert"
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
