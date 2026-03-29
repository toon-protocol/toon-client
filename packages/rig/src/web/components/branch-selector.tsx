import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { shortRefName } from '@/lib/ref-utils';
import type { RepoRefs } from '../nip34-parsers.js';

interface BranchSelectorProps {
  refs: RepoRefs;
  /** Short ref name (e.g. "main", not "refs/heads/main") */
  currentRef: string;
  /** Called with the full ref key from the refs map */
  onSelect: (fullRefName: string) => void;
}

export function BranchSelector({ refs, currentRef, onSelect }: BranchSelectorProps) {
  const [open, setOpen] = useState(false);
  const branches = [...refs.refs.keys()].filter((r) => r !== 'HEAD');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 font-mono text-xs">
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.5 2.5 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM3.5 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z" />
          </svg>
          {currentRef}
          <svg className="ml-1 h-3 w-3 opacity-60" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z" />
          </svg>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Find a branch..." />
          <CommandList>
            <CommandEmpty>No branches found.</CommandEmpty>
            <CommandGroup heading="Branches">
              {branches.map((fullRef) => {
                const short = shortRefName(fullRef);
                return (
                  <CommandItem
                    key={fullRef}
                    value={short}
                    onSelect={() => {
                      onSelect(fullRef);
                      setOpen(false);
                    }}
                    className={short === currentRef ? 'font-semibold' : ''}
                  >
                    {short}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
