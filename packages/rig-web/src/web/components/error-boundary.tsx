import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Per-tab error boundary: contains render crashes to an inline error card
 * instead of white-screening the whole app (the router/header stay mounted).
 *
 * Mount with a `key` tied to the current route (e.g. `location.pathname`)
 * so navigating away from a crashed view resets the boundary.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[rig-web] view crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 p-4"
        >
          <div className="font-medium">Something went wrong rendering this view.</div>
          <div className="mt-1 text-sm text-muted-foreground">
            {this.state.error.message}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            The rest of the app is still usable — try another tab or reload the page.
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
