import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

interface OpenCloseToggleProps {
  openCount: number;
  closedCount: number;
  value: 'open' | 'closed';
  onChange: (value: 'open' | 'closed') => void;
}

export function OpenCloseToggle({ openCount, closedCount, value, onChange }: OpenCloseToggleProps) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => { if (v) onChange(v as 'open' | 'closed'); }}
    >
      <ToggleGroupItem value="open" className="gap-1 text-xs">
        <svg className="h-4 w-4 text-green-600" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
        {openCount} Open
      </ToggleGroupItem>
      <ToggleGroupItem value="closed" className="gap-1 text-xs">
        <svg className="h-4 w-4 text-purple-600" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="8" r="5" />
        </svg>
        {closedCount} Closed
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
