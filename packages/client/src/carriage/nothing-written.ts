/**
 * The one fact the carriage's retry rule turns on: none of the packet left.
 *
 * An adapter throws this only where it KNOWS nothing was written: the dial or
 * connect step failed, or the session was not open when the packet was about
 * to go out. It is recorded where that step runs, never read back from an error
 * message afterwards. Every other failure is treated as written, because a
 * packet that may have left may have been banked (ADR 0007).
 *
 * Its own module so the adapters can raise it without importing the carriage
 * that imports them.
 */
export class NothingWritten extends Error {
  constructor(readonly error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'NothingWritten';
  }
}
