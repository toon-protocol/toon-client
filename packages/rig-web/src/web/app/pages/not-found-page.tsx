import { Link } from 'react-router';

/**
 * Catch-all route: an unmatched URL must render an inline "not found" card,
 * never an empty page (React Router renders nothing for unmatched paths,
 * which white-screened the whole app before this existed — #277).
 */
export function NotFoundPage() {
  return (
    <div className="rounded-md border p-8 text-center">
      <div className="text-lg font-medium">Page not found</div>
      <p className="mt-1 text-sm text-muted-foreground">
        This URL doesn&apos;t match any view in The Rig.
      </p>
      <Link
        to="/"
        className="mt-3 inline-block text-sm text-primary hover:underline"
      >
        Back to repositories
      </Link>
    </div>
  );
}
