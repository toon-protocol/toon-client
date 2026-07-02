import { Outlet } from 'react-router';
import { TopNav } from '@/components/top-nav';

export function AppLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopNav />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
