/**
 * Pure text utilities for turning a raw `git format-patch` / mbox email
 * (the on-chain PR `content` field, produced by `rig pr create` and
 * consumed by `git am`) into a human-readable body for display.
 *
 * The diff itself is never discarded by rig-web: it's always available
 * verbatim and rendered from the actual git objects in the "Files
 * Changed" tab (see `diff-view.tsx` / `use-commit-detail.ts`). This
 * module only produces a *display* string for the Conversation tab when
 * a PR has no explicit `description` tag (older `rig pr create`
 * invocations, or patches authored directly with `git format-patch`),
 * so the ugly raw mbox blob (headers + diffstat + diff + signature)
 * isn't dumped into the comment thread.
 */

const FROM_LINE = /^From [0-9a-f]{7,40} .+$/;
const SUBJECT_PREFIX = /^Subject:\s*(?:\[PATCH[^\]]*\]\s*)?/i;
const HEADER_LINE = /^[A-Za-z-]+:\s?/;
const CONTINUATION_LINE = /^[ \t]/;

/**
 * Strip format-patch/mbox headers (`From <sha> ...`, `From:`, `Date:`,
 * `Subject: [PATCH] `), the `---` diffstat block, the diff body, and the
 * trailing `git format-patch` signature (`-- \n<version>`) from a raw
 * patch email, leaving only the human-written subject + body.
 *
 * Falls back to returning `raw` unchanged if it doesn't look like a
 * format-patch email — no fabrication: if we can't confidently parse
 * it, show it as-is rather than mangling arbitrary content.
 */
export function stripPatchHeaders(raw: string): string {
  if (!raw) return raw;

  const lines = raw.split('\n');
  if (!FROM_LINE.test(lines[0] ?? '')) {
    // Doesn't look like a format-patch email; leave untouched.
    return raw;
  }

  let i = 1;
  let subject: string | null = null;

  // Consume RFC-2822-ish headers (From:, Date:, Subject:, ...) up to the
  // first blank line. `Subject:` may wrap onto continuation lines that
  // start with whitespace, per RFC 2822 folding.
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line === '') {
      i++;
      break;
    }
    if (/^Subject:/i.test(line)) {
      subject = line.replace(SUBJECT_PREFIX, '').trim();
      let j = i + 1;
      while (j < lines.length && CONTINUATION_LINE.test(lines[j] ?? '')) {
        subject = `${subject} ${(lines[j] ?? '').trim()}`;
        j++;
      }
      i = j - 1;
    } else if (!HEADER_LINE.test(line)) {
      // Not a recognizable header line — headers are over (e.g. this
      // patch has no blank line separating headers from body).
      break;
    }
  }

  const bodyLines = lines.slice(i);

  // The diffstat/diff starts at a line that is exactly '---', or (if
  // that marker is missing, e.g. a hand-written patch) at the first
  // `diff --git` line.
  let cutIndex = bodyLines.findIndex((l) => l === '---');
  if (cutIndex === -1) {
    cutIndex = bodyLines.findIndex((l) => l.startsWith('diff --git'));
  }

  let body = (cutIndex === -1 ? bodyLines : bodyLines.slice(0, cutIndex)).join(
    '\n',
  );

  // Trailing `git format-patch` signature ("-- \n2.34.1"), for the case
  // where there was no diffstat/diff to already cut it off.
  body = body.replace(/\n-- \n[^\n]*\s*$/, '');
  body = body.trim();

  if (subject) {
    return body ? `${subject}\n\n${body}` : subject;
  }
  return body;
}
