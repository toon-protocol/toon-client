import { Link } from 'react-router';
import { ThemeToggle } from '@/components/theme-toggle';

export function TopNav() {
  return (
    <header className="sticky top-0 z-50 border-b bg-primary text-primary-foreground">
      <div className="mx-auto flex h-12 max-w-[1280px] items-center justify-between px-4 lg:px-6">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <span className="text-lg" aria-hidden="true">&#x2692;</span>
          The Rig
        </Link>
        <ThemeToggle />
      </div>
    </header>
  );
}
