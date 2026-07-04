import { cn } from '@/lib/utils';

interface OpenCloseToggleProps {
  openCount: number;
  closedCount: number;
  value: 'open' | 'closed';
  onChange: (value: 'open' | 'closed') => void;
}

/** Green open-issue ring, matching the row status icon used across list/detail pages. */
function OpenIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

/** Purple closed/merged dot, matching the row status icon used across list/detail pages. */
function ClosedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="8" r="5" />
    </svg>
  );
}

/**
 * GitHub-style in-header Open/Closed toggle: a `bg-muted/40` bar meant to sit
 * as the first row of a list card, with the counts doubling as filter
 * buttons (bold when active). Shared by the issue and PR list pages, so it
 * stays generic — counts + value + onChange only, no issue/PR-specific data.
 */
export function OpenCloseToggle({ openCount, closedCount, value, onChange }: OpenCloseToggleProps) {
  return (
    <div className="flex items-center gap-4 rounded-t-md border-b bg-muted/40 px-4 py-2">
      <button
        type="button"
        aria-pressed={value === 'open'}
        onClick={() => onChange('open')}
        className={cn(
          'flex items-center gap-1.5 text-sm',
          value === 'open'
            ? 'font-semibold text-foreground'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        <OpenIcon className="h-4 w-4 text-success" />
        {openCount} Open
      </button>
      <button
        type="button"
        aria-pressed={value === 'closed'}
        onClick={() => onChange('closed')}
        className={cn(
          'flex items-center gap-1.5 text-sm',
          value === 'closed'
            ? 'font-semibold text-foreground'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        <ClosedIcon className="h-4 w-4 text-purple-600 dark:text-purple-400" />
        {closedCount} Closed
      </button>
    </div>
  );
}
