import { useEffect, useMemo } from 'react';
import { useProfileCache } from '@/hooks/use-profile-cache';
import { formatRelativeDate } from '../date-utils.js';
import { renderMarkdownSafe } from '../markdown-safe.js';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
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
    <div className="space-y-4">
      {allItems.map((item, i) => {
        const displayName = getDisplayName(item.authorPubkey);
        const initials = displayName.slice(0, 2).toUpperCase();
        const html = renderMarkdownSafe(item.content);

        return (
          <div key={item.eventId}>
            {i > 0 && <Separator className="mb-4" />}
            <Card>
              <CardHeader className="flex flex-row items-center gap-3 pb-2">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                </Avatar>
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{displayName}</span>
                  <span className="text-muted-foreground">
                    {formatRelativeDate(item.createdAt)}
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                <div
                  className="prose prose-sm max-w-none dark:prose-invert"
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              </CardContent>
            </Card>
          </div>
        );
      })}
    </div>
  );
}
