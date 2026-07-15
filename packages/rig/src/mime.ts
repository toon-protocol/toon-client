/**
 * File-extension → MIME type derivation for permaweb site deploys (#368).
 *
 * Every `rig push` already stores a repo's raw blob bytes on Arweave; tagging
 * each blob upload with a `Content-Type` derived from its path turns a pushed
 * repo into a servable static site (a gateway returns `text/html` for
 * `index.html` instead of `application/octet-stream`). The store forwards the
 * kind:5094 `output` tag to the Turbo upload's `Content-Type` — verified
 * against `@toon-protocol/core`'s `buildBlobStorageRequest` (sets
 * `["output", contentType]`) and its inverse parser (reads the `output` tag
 * back into `contentType`, defaulting to `application/octet-stream`).
 *
 * The map is deliberately small — the common static-site asset extensions —
 * and any unknown or extensionless path falls back to the octet-stream
 * default (the same default the store applies for an absent `output`), so
 * this never guesses wildly.
 */

/** The universal fallback: the store's own default for an absent `output`. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * Lowercased extension (no dot) → MIME type. Curated for static sites; extend
 * as real deploys need more. Anything absent falls back to octet-stream.
 */
const EXTENSION_MIME: ReadonlyMap<string, string> = new Map([
  // Markup / documents
  ['html', 'text/html'],
  ['htm', 'text/html'],
  ['xml', 'application/xml'],
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['csv', 'text/csv'],
  ['pdf', 'application/pdf'],
  // Styles / scripts
  ['css', 'text/css'],
  ['js', 'text/javascript'],
  ['mjs', 'text/javascript'],
  ['cjs', 'text/javascript'],
  ['map', 'application/json'],
  ['json', 'application/json'],
  ['wasm', 'application/wasm'],
  // Fonts
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['ttf', 'font/ttf'],
  ['otf', 'font/otf'],
  ['eot', 'application/vnd.ms-fontobject'],
  // Images
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['svg', 'image/svg+xml'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['ico', 'image/x-icon'],
  ['bmp', 'image/bmp'],
  // Media
  ['mp3', 'audio/mpeg'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['ogg', 'audio/ogg'],
  ['wav', 'audio/wav'],
]);

/** The lowercased extension of a path (no leading dot), or `undefined`. */
function extensionOf(path: string): string | undefined {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf('.');
  // A leading dot (dotfile like `.gitignore`) or no dot → no usable extension.
  if (dot <= 0) return undefined;
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Derive a `Content-Type` from a file path's extension. Unknown/extensionless
 * paths (and `undefined`) fall back to {@link DEFAULT_CONTENT_TYPE}.
 */
export function contentTypeForPath(path: string | undefined): string {
  if (!path) return DEFAULT_CONTENT_TYPE;
  const ext = extensionOf(path);
  if (ext === undefined) return DEFAULT_CONTENT_TYPE;
  return EXTENSION_MIME.get(ext) ?? DEFAULT_CONTENT_TYPE;
}

/**
 * Pick a single deterministic upload path for a blob reachable by MULTIPLE
 * paths (the same content committed under different names). The store keys a
 * blob by its content, so it carries ONE `Content-Type`:
 *
 *   - all paths agree on a content type → the lexicographically-first path
 *     (deterministic across runs);
 *   - the paths DISAGREE (e.g. `a.js` and `a.txt` share bytes) → `undefined`,
 *     so the caller uploads it as {@link DEFAULT_CONTENT_TYPE} rather than
 *     silently favoring one extension over another.
 *
 * An empty list yields `undefined` (octet-stream).
 */
export function resolveConflictingPath(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const sorted = [...paths].sort();
  const types = new Set(sorted.map((p) => contentTypeForPath(p)));
  if (types.size === 1) return sorted[0];
  return undefined;
}
