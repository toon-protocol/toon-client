/**
 * Markdown renderer for Forge-UI README display.
 *
 * Uses `marked` for full GitHub Flavored Markdown rendering, with a
 * post-processing sanitizer that strips dangerous HTML (script, style,
 * event handlers) while allowing safe structural tags.
 *
 * This is separate from `markdown-safe.ts` which is the escape-first
 * renderer used for user-generated content (issues, comments). README
 * files are git-committed content that commonly contains embedded HTML
 * (badges, centered layouts, images) that must render correctly.
 */

import { marked } from 'marked';
import { escapeHtml } from './escape.js';

/** HTML tags allowed in rendered markdown. All others are stripped. */
const ALLOWED_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'code',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'ol',
  'p',
  'picture',
  'pre',
  'q',
  's',
  'samp',
  'small',
  'source',
  'span',
  'strike',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'tt',
  'ul',
  'var',
]);

/** HTML attributes allowed on specific tags. */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title', 'width', 'height', 'loading']),
  div: new Set(['align', 'class']),
  p: new Set(['align', 'class']),
  span: new Set(['class']),
  td: new Set(['align', 'valign', 'colspan', 'rowspan']),
  th: new Set(['align', 'valign', 'colspan', 'rowspan']),
  ol: new Set(['start', 'type']),
  details: new Set(['open']),
  source: new Set(['srcset', 'media', 'type']),
  code: new Set(['class']),
  pre: new Set(['class']),
};

/** Protocols allowed in href/src attributes. Relative paths (no protocol) are also safe. */
const SAFE_URL_RE = /^(?:https?:\/\/|mailto:|#|\/|[a-zA-Z0-9._-])/i;

/** Dangerous URL schemes that must be blocked even if they match the general pattern. */
const DANGEROUS_URL_RE = /^(?:javascript|vbscript|data):/i;

/**
 * Sanitize rendered HTML by stripping dangerous tags and attributes.
 *
 * Allows safe structural tags (div, table, img, a, etc.) while removing
 * script, style, iframe, form, and all event handler attributes.
 */
function sanitizeHtml(html: string): string {
  // Remove script, style, iframe, form, input, textarea, select, button entirely (including content)
  let result = html.replace(
    /<(script|style|iframe|form|input|textarea|select|button)\b[^>]*>[\s\S]*?<\/\1>/gi,
    ''
  );
  // Remove self-closing dangerous tags
  result = result.replace(
    /<(script|style|iframe|form|input|textarea|select|button)\b[^>]*\/?>/gi,
    ''
  );

  // Process remaining tags: strip disallowed tags, strip disallowed attributes
  result = result.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)?\/?>/g,
    (match, tagName: string, attrs: string) => {
      const tag = tagName.toLowerCase();
      const isClosing = match.startsWith('</');

      if (!ALLOWED_TAGS.has(tag)) {
        return ''; // Strip disallowed tags entirely
      }

      if (isClosing) {
        return `</${tag}>`;
      }

      // Filter attributes
      const allowedForTag = ALLOWED_ATTRS[tag];
      const selfClosing = match.endsWith('/>');
      let cleanAttrs = '';

      if (attrs && allowedForTag) {
        // Parse attributes: name="value" or name='value' or name=value or name
        const attrRegex =
          /([a-zA-Z][a-zA-Z0-9_-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(attrs)) !== null) {
          const attrName = attrMatch[1]!.toLowerCase();
          const attrValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';

          // Skip event handlers (on*)
          if (attrName.startsWith('on')) continue;

          // Skip disallowed attributes
          if (!allowedForTag.has(attrName)) continue;

          // Block dangerous URL schemes (javascript:, vbscript:, data:)
          if (
            (attrName === 'href' || attrName === 'src') &&
            DANGEROUS_URL_RE.test(attrValue)
          ) {
            continue;
          }

          cleanAttrs += ` ${attrName}="${escapeHtml(attrValue)}"`;
        }
      }

      // Add security attrs to links
      if (tag === 'a') {
        if (!cleanAttrs.includes('rel=')) {
          cleanAttrs += ' rel="noopener noreferrer"';
        }
        if (!cleanAttrs.includes('target=')) {
          cleanAttrs += ' target="_blank"';
        }
      }

      // Add loading=lazy to images
      if (tag === 'img' && !cleanAttrs.includes('loading=')) {
        cleanAttrs += ' loading="lazy"';
      }

      return `<${tag}${cleanAttrs}${selfClosing ? ' /' : ''}>`;
    }
  );

  return result;
}

/** Options for markdown rendering. */
export interface MarkdownOptions {
  /**
   * Resolve a relative image/link path to an absolute URL.
   * Used to rewrite paths like `docs/img.png` to Arweave gateway URLs.
   * If not provided or returns null, relative paths are left as-is.
   */
  resolveRelativePath?: (relativePath: string) => string | null;
}

/**
 * Render markdown content to safe HTML for README display.
 *
 * Uses `marked` for full GFM rendering, then sanitizes the output
 * to strip dangerous HTML while preserving safe structural elements.
 *
 * @param content - Raw markdown string
 * @param options - Optional rendering options (relative path resolver, etc.)
 * @returns Sanitized HTML string
 */
export function renderMarkdown(
  content: string,
  options?: MarkdownOptions
): string {
  const rawHtml = marked.parse(content, {
    gfm: true,
    breaks: false,
  }) as string;

  let result = sanitizeHtml(rawHtml);

  // Rewrite relative image src and link href attributes if a resolver is provided
  if (options?.resolveRelativePath) {
    const resolve = options.resolveRelativePath;
    result = result.replace(
      /(<(?:img|source)\b[^>]*\bsrc=")([^"]+)(")/gi,
      (_match, before: string, src: string, after: string) => {
        if (/^(?:https?:\/\/|data:|\/\/)/i.test(src)) return _match; // absolute — keep
        const resolved = resolve(src);
        return resolved ? `${before}${escapeHtml(resolved)}${after}` : _match;
      }
    );
  }

  return result;
}
