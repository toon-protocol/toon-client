import { useMemo, Fragment } from 'react';
import { useParams, useOutletContext, Link } from 'react-router';
import type { RepoContext } from '@/app/repo-layout';
import { useBlame } from '@/hooks/use-blame';
import { parseAuthorIdent } from '../../git-objects.js';
import { formatRelativeDate } from '../../date-utils.js';
import { resolveRefSha } from '@/lib/ref-utils';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

export function BlamePage() {
  const { ref = '', '*': splat = '' } = useParams();
  const { metadata, refs, owner, repo } = useOutletContext<RepoContext>();
  const pathSegments = splat.split('/').filter(Boolean);
  const filePath = pathSegments.join('/');

  const startSha = useMemo(() => {
    if (!refs) return null;
    return resolveRefSha(ref, refs) ?? null;
  }, [refs, ref]);

  const { result, blameError, loading, error } = useBlame(
    filePath || null,
    startSha,
    metadata.repoId,
    refs,
  );

  if (error) {
    return <div className="text-destructive-foreground">Failed to compute blame: {error.message}</div>;
  }

  if (blameError) {
    return (
      <div className="text-muted-foreground">
        {blameError.reason === 'binary' ? 'Cannot blame binary files.' : 'File not found.'}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 15 }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    );
  }

  if (!result) {
    return <div className="text-muted-foreground">No blame data available.</div>;
  }

  const fileLines = result.fileContent.split('\n');

  // Group consecutive lines by commit SHA for alternating backgrounds
  let prevSha = '';
  let blockIndex = 0;
  const lineBlocks: number[] = [];
  for (const line of result.lines) {
    if (line.commitSha !== prevSha) {
      blockIndex++;
      prevSha = line.commitSha;
    }
    lineBlocks.push(blockIndex);
  }

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to={`/${owner}/${repo}`}>{metadata.name}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {pathSegments.map((segment, i) => {
            const partialPath = pathSegments.slice(0, i + 1).join('/');
            const isLast = i === pathSegments.length - 1;
            return (
              <Fragment key={partialPath}>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {isLast ? (
                    <span className="font-medium">{segment}</span>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link to={`/${owner}/${repo}/tree/${ref}/${partialPath}`}>{segment}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>

      {result.beyondLimit && (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
          Blame depth limit ({result.maxDepth} commits) reached. Some lines may show the oldest traversed commit instead of the actual origin.
        </div>
      )}

      {/* Blame table */}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <tbody>
            {result.lines.map((line, i) => {
              const blockVal = lineBlocks[i] ?? 0;
              const isEvenBlock = (blockVal % 2) === 0;
              const bgClass = isEvenBlock ? 'bg-muted/30' : '';
              const showGutter = i === 0 || result.lines[i - 1]?.commitSha !== line.commitSha;
              const author = parseAuthorIdent(line.author);

              return (
                <tr key={line.lineNumber} className={bgClass}>
                  <td className="w-28 whitespace-nowrap border-r px-2 py-0.5 align-top text-muted-foreground">
                    {showGutter ? (
                      <div className="flex flex-col">
                        <Link
                          to={`/${owner}/${repo}/commit/${line.commitSha}`}
                          className="font-mono hover:text-primary hover:underline"
                        >
                          {line.commitSha.slice(0, 7)}
                        </Link>
                        <span className="truncate text-[10px]">
                          {author?.name ?? '?'}
                        </span>
                        <span className="text-[10px]">
                          {formatRelativeDate(line.timestamp)}
                        </span>
                      </div>
                    ) : null}
                  </td>
                  <td className="w-10 border-r px-2 py-0.5 text-right text-muted-foreground">
                    {line.lineNumber}
                  </td>
                  <td className="whitespace-pre px-2 py-0.5 font-mono">
                    {fileLines[i] ?? ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
