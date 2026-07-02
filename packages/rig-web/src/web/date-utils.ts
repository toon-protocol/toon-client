/**
 * Date formatting utilities for Rig-UI.
 *
 * Provides relative date formatting for commit timestamps.
 * No external date library — uses vanilla JS Date math.
 */

/**
 * Format a Unix timestamp (seconds) as a relative date string.
 *
 * Returns human-readable strings like "just now", "5 minutes ago",
 * "2 hours ago", "3 days ago", "2 months ago", "1 year ago".
 *
 * @param timestamp - Unix timestamp in seconds
 * @returns Relative date string
 */
export function formatRelativeDate(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 0) {
    return 'just now';
  }

  if (diff < 60) {
    return 'just now';
  }

  const minutes = Math.floor(diff / 60);
  if (minutes < 60) {
    return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  }

  const hours = Math.floor(diff / 3600);
  if (hours < 24) {
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }

  const days = Math.floor(diff / 86400);
  if (days < 30) {
    return days === 1 ? '1 day ago' : `${days} days ago`;
  }

  const months = Math.floor(days / 30);
  if (months < 12) {
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }

  const years = Math.floor(days / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}
