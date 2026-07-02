import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ErrorBoundary } from '@/components/error-boundary';
import { NotFoundPage } from '@/app/pages/not-found-page';
import { AppLayout } from '@/app/app-layout';

function Bomb(): never {
  throw new Error('kaboom: merge commit from the future');
}

afterEach(cleanup);

describe('[P0] ErrorBoundary', () => {
  it('renders an inline error card instead of unmounting the tree', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <div>
          <header>still standing</header>
          <ErrorBoundary>
            <Bomb />
          </ErrorBoundary>
        </div>,
      );
      // The crash is contained: surrounding chrome survives...
      expect(screen.getByText('still standing')).toBeInTheDocument();
      // ...and an inline error card is shown in place of the crashed view
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(
        screen.getByText('Something went wrong rendering this view.'),
      ).toBeInTheDocument();
      expect(
        screen.getByText('kaboom: merge commit from the future'),
      ).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>happy path</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('happy path')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('[P0] NotFoundPage catch-all (#277)', () => {
  it('unmatched URLs render an inline card with the app header intact', () => {
    render(
      <MemoryRouter initialEntries={['/some/unrouted/path/commits']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<div>home</div>} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    // Header stays (no white screen)...
    expect(screen.getByText('The Rig')).toBeInTheDocument();
    // ...and the user gets a way back instead of a blank page
    expect(screen.getByText('Page not found')).toBeInTheDocument();
    expect(screen.getByText('Back to repositories')).toBeInTheDocument();
  });
});
