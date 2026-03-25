/* eslint-disable @typescript-eslint/no-non-null-assertion -- safe array-index accesses in binary parsing */
/**
 * Browser-compatible git object parsers for Rig-UI.
 *
 * Parses git tree, commit, and blob objects from raw bytes (Uint8Array).
 * Does NOT use Node.js Buffer — uses Uint8Array, TextDecoder, and manual
 * hex encoding for browser compatibility.
 */

/**
 * A single entry in a git tree object.
 */
export interface TreeEntry {
  /** File mode (e.g., '100644', '100755', '40000', '120000', '160000') */
  mode: string;
  /** File or directory name */
  name: string;
  /** SHA-1 hash as a 40-character hex string */
  sha: string;
}

/**
 * Parsed git commit object.
 */
export interface GitCommit {
  /** SHA-1 of the tree object */
  treeSha: string;
  /** SHA-1 hashes of parent commits */
  parentShas: string[];
  /** Author identity line (e.g., "Name <email> timestamp timezone") */
  author: string;
  /** Committer identity line */
  committer: string;
  /** Commit message body */
  message: string;
}

/**
 * Convert raw bytes to a hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (const byte of bytes) {
    hex.push(byte.toString(16).padStart(2, '0'));
  }
  return hex.join('');
}

/**
 * Parse a git tree object from raw bytes.
 *
 * Git tree format: `<mode-ascii-space><name-utf8-null><20-byte-sha-binary>` repeated.
 *
 * @param data - Raw tree object bytes (without git object header)
 * @returns Array of TreeEntry objects
 */
export function parseGitTree(data: Uint8Array): TreeEntry[] {
  if (data.length === 0) {
    return [];
  }

  const entries: TreeEntry[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let offset = 0;

  while (offset < data.length) {
    // Find the space separating mode from name
    let spaceIndex = offset;
    while (spaceIndex < data.length && data[spaceIndex] !== 0x20) {
      spaceIndex++;
    }
    if (spaceIndex >= data.length) break;

    // Mode is ASCII bytes before the space
    const mode = decoder.decode(data.subarray(offset, spaceIndex));

    // Find the null byte separating name from SHA
    let nullIndex = spaceIndex + 1;
    while (nullIndex < data.length && data[nullIndex] !== 0x00) {
      nullIndex++;
    }
    if (nullIndex >= data.length) break;

    // Name is UTF-8 bytes between space+1 and null
    const name = decoder.decode(data.subarray(spaceIndex + 1, nullIndex));

    // SHA is the next 20 bytes after the null
    const shaStart = nullIndex + 1;
    const shaEnd = shaStart + 20;
    if (shaEnd > data.length) break;

    const sha = bytesToHex(data.subarray(shaStart, shaEnd));

    entries.push({ mode, name, sha });
    offset = shaEnd;
  }

  return entries;
}

/**
 * Parse a git commit object from raw bytes.
 *
 * Commit format:
 * ```
 * tree <sha>\n
 * parent <sha>\n  (zero or more)
 * author <ident> <timestamp> <tz>\n
 * committer <ident> <timestamp> <tz>\n
 * \n
 * <message>
 * ```
 *
 * @param data - Raw commit object bytes (without git object header)
 * @returns Parsed GitCommit, or null if malformed
 */
export function parseGitCommit(data: Uint8Array): GitCommit | null {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const text = decoder.decode(data);

  // Split headers from message at the first blank line
  const blankLineIndex = text.indexOf('\n\n');
  if (blankLineIndex === -1) {
    return null;
  }

  const headerSection = text.slice(0, blankLineIndex);
  const message = text.slice(blankLineIndex + 2);
  const headerLines = headerSection.split('\n');

  let treeSha = '';
  const parentShas: string[] = [];
  let author = '';
  let committer = '';

  for (const line of headerLines) {
    if (line.startsWith('tree ')) {
      treeSha = line.slice(5);
    } else if (line.startsWith('parent ')) {
      parentShas.push(line.slice(7));
    } else if (line.startsWith('author ')) {
      author = line.slice(7);
    } else if (line.startsWith('committer ')) {
      committer = line.slice(10);
    }
  }

  if (!treeSha) {
    return null;
  }

  return { treeSha, parentShas, author, committer, message };
}

/**
 * Parsed author/committer identity from a git commit.
 */
export interface AuthorIdent {
  /** Author name */
  name: string;
  /** Author email */
  email: string;
  /** Unix timestamp in seconds */
  timestamp: number;
  /** Timezone offset string (e.g., "+0000", "-0500") */
  timezone: string;
}

/**
 * Parse a git author/committer identity string.
 *
 * Format: "Name <email> timestamp timezone"
 * Example: "Alice <alice@example.com> 1711234567 +0000"
 *
 * @param ident - Raw identity string from a commit object
 * @returns Parsed AuthorIdent, or null if malformed
 */
export function parseAuthorIdent(ident: string): AuthorIdent | null {
  // Match: Name <email> timestamp timezone
  const match = /^(.+?)\s+<([^>]*)>\s+(\d+)\s+([+-]\d{4})$/.exec(ident);
  if (!match) return null;

  const name = match[1]!;
  const email = match[2]!;
  const timestamp = parseInt(match[3]!, 10);
  const timezone = match[4]!;

  if (isNaN(timestamp)) return null;

  return { name, email, timestamp, timezone };
}

/**
 * Detect whether raw blob bytes contain binary content.
 *
 * Returns true if:
 * - Any null byte (0x00) is found in the first 8192 bytes, OR
 * - More than 30% of bytes in the first 8192 bytes are non-printable
 *   (outside 0x09-0x0D and 0x20-0x7E ranges)
 *
 * @param data - Raw blob bytes
 * @returns true if the content appears to be binary
 */
export function isBinaryBlob(data: Uint8Array): boolean {
  const checkLength = Math.min(data.length, 8192);
  if (checkLength === 0) return false;

  let nonPrintable = 0;

  for (let i = 0; i < checkLength; i++) {
    const byte = data[i]!;

    // Null byte is a strong binary indicator
    if (byte === 0x00) return true;

    // Check if non-printable (outside tab/newline/CR/FF and printable ASCII)
    const isPrintable =
      (byte >= 0x09 && byte <= 0x0d) || (byte >= 0x20 && byte <= 0x7e);
    if (!isPrintable) {
      nonPrintable++;
    }
  }

  return nonPrintable / checkLength > 0.3;
}
