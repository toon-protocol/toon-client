import { useState, useEffect, useMemo } from 'react';
import { isBinaryBlob } from '../git-objects.js';
import { renderMarkdown } from '../markdown-renderer.js';
import { useResolveImages } from '@/hooks/use-resolve-images';
import { useBlame } from '@/hooks/use-blame';
import { parseAuthorIdent } from '../git-objects.js';
import { formatRelativeDate } from '../date-utils.js';
import { CodeView } from '@/components/code-view';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import type { RepoRefs } from '../nip34-parsers.js';

interface FileViewerProps {
  data: Uint8Array;
  filename: string;
  filePath?: string;
  resolveRelativePath?: (path: string) => string | null;
  treeSha?: string | null;
  repoId?: string;
  refs?: RepoRefs | null;
  commitSha?: string | null;
}

function isMarkdownFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx');
}

export function FileViewer({
  data, filename, filePath, resolveRelativePath,
  treeSha, repoId, refs, commitSha,
}: FileViewerProps) {
  const [view, setView] = useState<'preview' | 'code' | 'blame'>('preview');

  const isBinary = isBinaryBlob(data);
  const isMarkdown = !isBinary && isMarkdownFile(filename);
  const decodedText = useMemo(
    () => (isBinary ? null : new TextDecoder().decode(data)),
    [data, isBinary],
  );

  const rawMarkdownHtml = useMemo(() => {
    if (!isMarkdown || !decodedText) return null;
    return renderMarkdown(decodedText, { resolveRelativePath });
  }, [isMarkdown, decodedText, resolveRelativePath]);

  const resolvedMarkdownHtml = useResolveImages(rawMarkdownHtml, treeSha ?? null, repoId ?? '', refs ?? null);

  useEffect(() => {
    if (!isMarkdown) setView('code');
  }, [isMarkdown]);

  // Blame — only compute when blame view is active
  const {
    result: blameResult,
    loading: blameLoading,
  } = useBlame(
    view === 'blame' ? (filePath ?? null) : null,
    view === 'blame' ? (commitSha ?? null) : null,
    repoId ?? '',
    refs ?? null,
  );

  // Build blame table HTML once (no React re-renders on the table)
  const blameTableHtml = useMemo(() => {
    if (!blameResult) return null;
    const fileLines = blameResult.fileContent.split('\n');
    let prevSha = '';
    let blockIndex = 0;
    const rows: string[] = [];

    for (let i = 0; i < blameResult.lines.length; i++) {
      const line = blameResult.lines[i];
      if (!line) continue;
      if (line.commitSha !== prevSha) {
        blockIndex++;
        prevSha = line.commitSha;
      }
      const isEven = blockIndex % 2 === 0;
      const isGroupStart = i === 0 || blameResult.lines[i - 1]?.commitSha !== line.commitSha;
      const author = parseAuthorIdent(line.author);
      const classes = [
        isEven ? 'blame-even' : 'blame-odd',
        isGroupStart ? 'blame-group-start' : '',
      ].filter(Boolean).join(' ');
      const gutterHtml = isGroupStart
        ? `<div><span style="font-family:ui-monospace,monospace;font-weight:500">${esc(line.commitSha.slice(0, 7))}</span><br><span>${esc(author?.name ?? '?')}</span><br><span>${esc(formatRelativeDate(line.timestamp))}</span></div>`
        : '';
      const codeLine = esc(fileLines[i] ?? '');

      rows.push(`<tr class="${classes}"><td class="blame-gutter">${gutterHtml}</td><td class="blame-num">${line.lineNumber}</td><td class="blame-code">${codeLine || '&nbsp;'}</td></tr>`);
    }
    return '<tbody>' + rows.join('') + '</tbody>';
  }, [blameResult]);

  const lines = decodedText ? decodedText.split('\n').length : 0;
  const sizeKb = (data.byteLength / 1024).toFixed(1);

  const viewButtons: { key: typeof view; label: string }[] = [];
  if (isMarkdown) viewButtons.push({ key: 'preview', label: 'Preview' });
  viewButtons.push({ key: 'code', label: 'Code' });
  if (commitSha && filePath) viewButtons.push({ key: 'blame', label: 'Blame' });

  return (
    <div className="overflow-hidden rounded-md border">
      {/* GitHub-style file header */}
      <div className="flex items-center justify-between border-b bg-muted/50 px-4 py-2">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {!isBinary && <span>{lines} lines</span>}
          <span>{sizeKb} KB</span>
        </div>
        {!isBinary && viewButtons.length > 1 && (
          <div className="inline-flex items-center rounded-md border bg-background p-0.5">
            {viewButtons.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={`rounded-sm px-3 py-1 text-xs font-medium transition-colors ${
                  view === key
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      {isBinary ? (
        <div className="px-4 py-8 text-center text-muted-foreground">
          Binary file not shown.
        </div>
      ) : view === 'preview' && isMarkdown ? (
        <ScrollArea>
          <div
            className="prose max-w-none p-6 dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: resolvedMarkdownHtml ?? '' }}
          />
        </ScrollArea>
      ) : view === 'blame' ? (
        blameLoading ? (
          <div className="space-y-1 p-4">
            {Array.from({ length: 15 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : blameTableHtml ? (
          <div className="overflow-auto">
            <table
              className="blame-table w-full text-xs"
              dangerouslySetInnerHTML={{ __html: blameTableHtml }}
            />
          </div>
        ) : (
          <div className="px-4 py-8 text-center text-muted-foreground">
            Could not compute blame.
          </div>
        )
      ) : decodedText ? (
        <CodeView text={decodedText} filename={filename} />
      ) : null}
    </div>
  );
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
