import { Link } from 'react-router';
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import type { TreeEntry } from '../git-objects.js';

interface FileTreeProps {
  entries: TreeEntry[];
  loading: boolean;
  basePath: string; // e.g. "/npub1.../repo/tree/main"
  blobPath: string; // e.g. "/npub1.../repo/blob/main"
}

function FolderIcon() {
  return (
    <svg className="h-4 w-4 text-muted-foreground" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="h-4 w-4 text-muted-foreground" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3.75 1.5a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6H9.75A1.75 1.75 0 0 1 8 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v9.086A1.75 1.75 0 0 1 12.25 16h-8.5A1.75 1.75 0 0 1 2 14.25V1.75z" />
    </svg>
  );
}

export function FileTree({ entries, loading, basePath, blobPath }: FileTreeProps) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  // Sort: directories first, then files, alphabetical within each
  const sorted = [...entries].sort((a, b) => {
    const aIsDir = a.mode === '40000' || a.mode === '040000';
    const bIsDir = b.mode === '40000' || b.mode === '040000';
    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="rounded-md border">
      <Table>
        <TableBody>
          {sorted.map((entry) => {
            const isDir = entry.mode === '40000' || entry.mode === '040000';
            const href = isDir
              ? `${basePath}/${entry.name}`
              : `${blobPath}/${entry.name}`;
            return (
              <TableRow key={entry.name}>
                <TableCell className="w-8 py-1.5 pl-3 pr-0">
                  {isDir ? <FolderIcon /> : <FileIcon />}
                </TableCell>
                <TableCell className="py-1.5">
                  <Link to={href} className="hover:text-primary hover:underline">
                    {entry.name}
                  </Link>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
