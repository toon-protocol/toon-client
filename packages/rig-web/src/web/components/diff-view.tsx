import { useCallback, useMemo, useState } from 'react';
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

interface FileStats {
  added: number;
  removed: number;
}

/** Count `+`/`-` line additions/removals in a unified diff body. */
function countDiffStats(diff: string): FileStats {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

function DiffFileSection({
  file,
  repoId,
  onStats,
}: {
  file: TreeDiffEntry;
  repoId: string;
  onStats: (name: string, stats: FileStats) => void;
}) {
  const [open, setOpen] = useState(false);
  // Fetch eagerly (not gated on `open`) so the diffstat header and this
  // file's own +/- counts are available even before the section is
  // expanded — GitHub shows real counts up front, not just on expand.
  const { diff, loading } = useFileDiff(file.oldSha, file.newSha, repoId, true);

  const stats = useMemo(() => (diff ? countDiffStats(diff) : null), [diff]);

  if (stats) {
    // Reported on every render where stats are available; the parent
    // dedupes via a keyed record so this is cheap and idempotent.
    onStats(file.name, stats);
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 border-b px-4 py-2 text-left text-sm hover:bg-muted/50">
        <span className="font-mono text-xs text-muted-foreground">
          {open ? '▾' : '▸'}
        </span>
        <Badge variant="outline" className={`text-[10px] ${STATUS_COLORS[file.status] ?? ''}`}>
          {file.status[0]?.toUpperCase()}
        </Badge>
        <span className="flex-1 truncate font-mono text-xs">{file.name}</span>
        {stats ? (
          <span className="shrink-0 font-mono text-[10px]">
            <span className="text-success">+{stats.added}</span>{' '}
            <span className="text-destructive">-{stats.removed}</span>
          </span>
        ) : loading ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">…</span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {loading && !diff ? (
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

/** A small GitHub-style row of colored squares representing the additions/deletions ratio. */
function DiffstatBar({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  if (total === 0) return null;
  const SQUARES = 5;
  const addedSquares = Math.min(SQUARES, Math.round((added / total) * SQUARES));
  const removedSquares = Math.min(SQUARES - addedSquares, Math.round((removed / total) * SQUARES));
  const neutralSquares = Math.max(0, SQUARES - addedSquares - removedSquares);

  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      {Array.from({ length: addedSquares }, (_, i) => (
        <span key={`a${i}`} className="h-2.5 w-2.5 rounded-[1px] bg-success" />
      ))}
      {Array.from({ length: removedSquares }, (_, i) => (
        <span key={`r${i}`} className="h-2.5 w-2.5 rounded-[1px] bg-destructive" />
      ))}
      {Array.from({ length: neutralSquares }, (_, i) => (
        <span key={`n${i}`} className="h-2.5 w-2.5 rounded-[1px] bg-muted" />
      ))}
    </span>
  );
}

export function DiffView({ files, repoId }: DiffViewProps) {
  const [statsByFile, setStatsByFile] = useState<Record<string, FileStats>>({});

  const handleStats = useCallback((name: string, stats: FileStats) => {
    setStatsByFile((prev) => {
      const existing = prev[name];
      if (existing && existing.added === stats.added && existing.removed === stats.removed) {
        return prev;
      }
      return { ...prev, [name]: stats };
    });
  }, []);

  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    let counted = 0;
    for (const file of files) {
      const s = statsByFile[file.name];
      if (s) {
        added += s.added;
        removed += s.removed;
        counted++;
      }
    }
    return { added, removed, counted };
  }, [files, statsByFile]);

  if (files.length === 0) {
    return <div className="text-sm text-muted-foreground">No files changed.</div>;
  }

  const allCounted = totals.counted === files.length;

  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
        <span>
          Showing {files.length} changed file{files.length !== 1 ? 's' : ''} with{' '}
          <span className="font-medium text-success">
            {totals.added} addition{totals.added !== 1 ? 's' : ''}
          </span>{' '}
          and{' '}
          <span className="font-medium text-destructive">
            {totals.removed} deletion{totals.removed !== 1 ? 's' : ''}
          </span>
          {!allCounted && <span> (calculating…)</span>}
        </span>
        <DiffstatBar added={totals.added} removed={totals.removed} />
      </div>
      {files.map((file) => (
        <DiffFileSection key={file.name} file={file} repoId={repoId} onStats={handleStats} />
      ))}
    </div>
  );
}
