import { useState } from 'react';
import { useFileDiff } from '@/hooks/use-commit-detail';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { TreeDiffEntry } from '../tree-diff.js';

interface DiffViewProps {
  files: TreeDiffEntry[];
  repoId: string;
}

const STATUS_COLORS: Record<string, string> = {
  added: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  deleted: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  modified: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
};

function DiffFileSection({ file, repoId }: { file: TreeDiffEntry; repoId: string }) {
  const [open, setOpen] = useState(false);
  const { diff, loading } = useFileDiff(file.oldSha, file.newSha, repoId, open);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 border-b px-4 py-2 text-left text-sm hover:bg-muted/50">
        <span className="font-mono text-xs text-muted-foreground">
          {open ? '▾' : '▸'}
        </span>
        <Badge variant="outline" className={`text-[10px] ${STATUS_COLORS[file.status] ?? ''}`}>
          {file.status[0]?.toUpperCase()}
        </Badge>
        <span className="font-mono text-xs">{file.name}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {loading ? (
          <div className="space-y-1 p-4">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : diff ? (
          <pre className="overflow-x-auto p-4 text-xs leading-5">
            {diff.split('\n').map((line, i) => {
              let className = '';
              if (line.startsWith('+') && !line.startsWith('+++')) {
                className = 'bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300';
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                className = 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300';
              } else if (line.startsWith('@@')) {
                className = 'text-blue-600 dark:text-blue-400';
              }
              return (
                <div key={i} className={className}>
                  {line}
                </div>
              );
            })}
          </pre>
        ) : (
          <div className="px-4 py-2 text-xs text-muted-foreground">No diff available.</div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function DiffView({ files, repoId }: DiffViewProps) {
  if (files.length === 0) {
    return <div className="text-sm text-muted-foreground">No files changed.</div>;
  }

  return (
    <div className="rounded-md border">
      <div className="border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
        {files.length} file{files.length !== 1 ? 's' : ''} changed
      </div>
      {files.map((file) => (
        <DiffFileSection key={file.name} file={file} repoId={repoId} />
      ))}
    </div>
  );
}
