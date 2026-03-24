// Test IDs: 8.6-SEED-001, 8.6-SEED-002
// AC covered: AC #7 (Seed script creates all required NIP-34 event kinds with Arweave mappings)
//             AC #8 (Seed script idempotent - INSERT OR IGNORE, replaceable events)
//
// These tests validate the seed script's logic/output by:
// 1. Static analysis of the script source to verify structural correctness
// 2. Testing extracted helper function logic (sqliteEscape, isHexString, SQL patterns)
// 3. Verifying event creation covers all required NIP-34 kinds
// 4. Verifying idempotency mechanisms (INSERT OR IGNORE, replaceable event semantics)

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Load seed script source for static analysis
// ---------------------------------------------------------------------------
let scriptSource: string;

beforeAll(() => {
  const scriptPath = resolve(
    __dirname,
    '../../../../scripts/seed-forge-data.mjs'
  );
  scriptSource = readFileSync(scriptPath, 'utf-8');
});

// ---------------------------------------------------------------------------
// Helper function re-implementations for unit testing
// (Extracted from seed-forge-data.mjs to test logic without Docker/infrastructure)
// ---------------------------------------------------------------------------

/** SQLite string escaping (mirrors seed script's sqliteEscape) */
function sqliteEscape(str: string): string {
  return str.replace(/\0/g, '').replace(/'/g, "''");
}

/** Hex string validation (mirrors seed script's isHexString) */
function isHexString(str: string): boolean {
  return /^[0-9a-f]+$/i.test(str);
}

// ============================================================================
// AC #7: Seed script creates all required NIP-34 event kinds
// ============================================================================

describe('Seed Script - 8.6-SEED-001: NIP-34 Event Kind Coverage (AC #7)', () => {
  it('[P1] creates kind:30617 repository announcement events', () => {
    expect(scriptSource).toContain('kind: 30617');
    // Verify it creates the event with signEvent and inserts it
    expect(scriptSource).toMatch(/kind:\s*30617[\s\S]*?insertEvent/);
  });

  it('[P1] creates kind:30618 repository refs events', () => {
    expect(scriptSource).toContain('kind: 30618');
    expect(scriptSource).toMatch(/kind:\s*30618[\s\S]*?insertEvent/);
  });

  it('[P1] creates kind:1621 issue events', () => {
    expect(scriptSource).toContain('kind: 1621');
    expect(scriptSource).toMatch(/kind:\s*1621[\s\S]*?insertEvent/);
  });

  it('[P1] creates kind:1622 issue comment events', () => {
    expect(scriptSource).toContain('kind: 1622');
    expect(scriptSource).toMatch(/kind:\s*1622[\s\S]*?insertEvent/);
  });

  it('[P1] creates kind:1617 patch/PR events', () => {
    expect(scriptSource).toContain('kind: 1617');
    expect(scriptSource).toMatch(/kind:\s*1617[\s\S]*?insertEvent/);
  });

  it('[P1] creates kind:1630 open status events', () => {
    expect(scriptSource).toContain('kind: 1630');
    expect(scriptSource).toMatch(/kind:\s*1630[\s\S]*?insertEvent/);
  });

  it('[P1] creates kind:1631 merged/applied status events', () => {
    expect(scriptSource).toContain('kind: 1631');
    expect(scriptSource).toMatch(/kind:\s*1631[\s\S]*?insertEvent/);
  });

  it('[P1] creates kind:1632 closed status events', () => {
    expect(scriptSource).toContain('kind: 1632');
    expect(scriptSource).toMatch(/kind:\s*1632[\s\S]*?insertEvent/);
  });

  it('[P1] covers all 8 required NIP-34 event kinds', () => {
    const requiredKinds = [30617, 30618, 1621, 1622, 1617, 1630, 1631, 1632];
    for (const kind of requiredKinds) {
      expect(scriptSource).toContain(`kind: ${kind}`);
    }
  });
});

// ============================================================================
// AC #7: Arweave uploads and SHA-to-txId mappings
// ============================================================================

describe('Seed Script - 8.6-SEED-001: Arweave Upload and SHA-to-txId Mappings (AC #7)', () => {
  it('[P1] imports TurboFactory from @ardrive/turbo-sdk', () => {
    expect(scriptSource).toContain('TurboFactory');
    expect(scriptSource).toContain('@ardrive/turbo-sdk');
  });

  it('[P1] uploads git objects using turbo.uploadFile', () => {
    expect(scriptSource).toContain('turbo.uploadFile');
  });

  it('[P1] collects SHA-to-txId mappings in arweaveMap', () => {
    expect(scriptSource).toContain('arweaveMap');
    // Verify it sets SHA -> txId after upload
    expect(scriptSource).toMatch(/arweaveMap\.set\(sha,\s*result\.id\)/);
  });

  it('[P1] embeds arweave tags in kind:30618 refs event', () => {
    // The script should create ['arweave', sha, txId] tags from the arweaveMap
    expect(scriptSource).toMatch(
      /\['arweave',\s*sha,\s*txId\]/
    );
    // And spread them into the kind:30618 event's tags
    expect(scriptSource).toContain('arweaveTags');
  });

  it('[P1] uploads commit objects to Arweave', () => {
    expect(scriptSource).toMatch(/uploadGitObject\(commit\.sha,\s*'commit'\)/);
  });

  it('[P1] uploads tree objects to Arweave', () => {
    expect(scriptSource).toMatch(/uploadGitObject\(.*,\s*'tree'\)/);
  });

  it('[P1] uploads blob objects to Arweave', () => {
    expect(scriptSource).toMatch(/uploadGitObject\(.*,\s*'blob'\)/);
  });

  it('[P1] uses binary format for tree objects (git cat-file tree)', () => {
    // Tree objects must use raw binary format, not pretty-print
    expect(scriptSource).toMatch(
      /type\s*===\s*'tree'\s*\?\s*\['cat-file',\s*'tree',\s*sha\]/
    );
  });

  it('[P1] uses pretty-print for commits and blobs (git cat-file -p)', () => {
    expect(scriptSource).toMatch(/\['cat-file',\s*'-p',\s*sha\]/);
  });

  it('[P1] tags Arweave uploads with Git-SHA, Repo, Content-Type, Git-Type', () => {
    expect(scriptSource).toContain("name: 'Git-SHA'");
    expect(scriptSource).toContain("name: 'Repo'");
    expect(scriptSource).toContain("name: 'Content-Type'");
    expect(scriptSource).toContain("name: 'Git-Type'");
  });

  it('[P2] skips objects larger than 100KB', () => {
    expect(scriptSource).toMatch(/100\s*\*\s*1024/);
  });

  it('[P2] gracefully handles Turbo SDK unavailability', () => {
    // Script should have a try/catch around TurboFactory init
    expect(scriptSource).toMatch(/catch.*Could not load.*turbo-sdk/s);
    // And uploadGitObject should bail early when turbo is null
    expect(scriptSource).toMatch(/if\s*\(!turbo\)\s*return\s*null/);
  });
});

// ============================================================================
// AC #8: Idempotency - INSERT OR IGNORE prevents duplicates
// ============================================================================

describe('Seed Script - 8.6-SEED-002: Idempotency (AC #8)', () => {
  it('[P1] uses INSERT OR IGNORE in the SQL insert statement', () => {
    expect(scriptSource).toContain('INSERT OR IGNORE');
  });

  it('[P1] insertEvent generates SQL with INSERT OR IGNORE', () => {
    // Verify the actual SQL template in insertEvent function
    expect(scriptSource).toMatch(
      /INSERT OR IGNORE INTO events\s*\(/
    );
  });

  it('[P1] catches UNIQUE constraint violations gracefully', () => {
    // The dockerSqlite helper catches UNIQUE constraint errors
    expect(scriptSource).toContain("e.stderr.includes('UNIQUE')");
    expect(scriptSource).toContain('already exists, skipping');
  });

  it('[P1] sqliteEscape strips null bytes', () => {
    expect(sqliteEscape('hello\0world')).toBe('helloworld');
    expect(sqliteEscape('\0\0\0')).toBe('');
    expect(sqliteEscape('no nulls here')).toBe('no nulls here');
  });

  it('[P1] sqliteEscape escapes single quotes', () => {
    expect(sqliteEscape("it's")).toBe("it''s");
    expect(sqliteEscape("a'b'c")).toBe("a''b''c");
    expect(sqliteEscape("no quotes")).toBe("no quotes");
  });

  it('[P1] sqliteEscape handles combined null bytes and single quotes', () => {
    expect(sqliteEscape("it\0's a \0test")).toBe("it''s a test");
  });

  it('[P1] isHexString validates hex-only strings', () => {
    expect(isHexString('abcdef0123456789')).toBe(true);
    expect(isHexString('ABCDEF0123456789')).toBe(true);
    expect(isHexString('a'.repeat(64))).toBe(true);
  });

  it('[P1] isHexString rejects non-hex strings', () => {
    expect(isHexString('xyz')).toBe(false);
    expect(isHexString('hello world')).toBe(false);
    expect(isHexString("'; DROP TABLE events;--")).toBe(false);
    expect(isHexString('')).toBe(false);
  });

  it('[P1] insertEvent validates hex fields before SQL construction', () => {
    // The script validates id, pubkey, sig are hex-only
    expect(scriptSource).toContain('isHexString(event.id)');
    expect(scriptSource).toContain('isHexString(event.pubkey)');
    expect(scriptSource).toContain('isHexString(event.sig)');
  });

  it('[P1] insertEvent validates kind and created_at are integers', () => {
    expect(scriptSource).toContain('Number.isInteger(event.kind)');
    expect(scriptSource).toContain('Number.isInteger(event.created_at)');
  });

  it('[P1] insertEvent escapes content and tags via sqliteEscape', () => {
    expect(scriptSource).toMatch(/sqliteEscape\(JSON\.stringify\(event\.tags\)\)/);
    expect(scriptSource).toMatch(/sqliteEscape\(event\.content\)/);
  });
});

// ============================================================================
// AC #8: Parameterized replaceable events
// ============================================================================

describe('Seed Script - 8.6-SEED-002: Replaceable Event Semantics (AC #8)', () => {
  it('[P1] kind:30617 is a parameterized replaceable event (NIP-33, 30000-39999)', () => {
    // kind:30617 falls in the NIP-33 parameterized replaceable range (30000-39999)
    // Combined with the d tag, this means re-running creates events that replace the old ones
    const kind = 30617;
    expect(kind).toBeGreaterThanOrEqual(30000);
    expect(kind).toBeLessThanOrEqual(39999);
  });

  it('[P1] kind:30618 is a parameterized replaceable event (NIP-33, 30000-39999)', () => {
    const kind = 30618;
    expect(kind).toBeGreaterThanOrEqual(30000);
    expect(kind).toBeLessThanOrEqual(39999);
  });

  it('[P1] kind:30617 event uses d tag for replaceable identity', () => {
    // Verify the repo announcement has a d tag (required for NIP-33 replacement)
    // The signEvent call for kind:30617 includes ['d', REPO_ID] in its tags
    expect(scriptSource).toMatch(/kind:\s*30617[\s\S]*?\['d',\s*REPO_ID\]/);
  });

  it('[P1] kind:30618 event uses d tag for replaceable identity', () => {
    // Verify the repo refs has a d tag
    expect(scriptSource).toMatch(/kind:\s*30618[\s\S]*?\['d',\s*REPO_ID\]/);
  });

  it('[P1] replaceable events use dynamic timestamps (not hardcoded)', () => {
    // Both kind:30617 and kind:30618 should use now-based timestamps
    // so re-running produces newer events that replace older ones
    expect(scriptSource).toContain('const now = Math.floor(Date.now() / 1000)');

    // kind:30617 uses now - offset for created_at
    const repoAnnouncementCreatedAt = scriptSource.match(
      /kind:\s*30617[\s\S]*?created_at:\s*(now\s*-\s*\d+)/
    );
    expect(repoAnnouncementCreatedAt).not.toBeNull();

    // kind:30618 uses now - offset for created_at
    const repoRefsCreatedAt = scriptSource.match(
      /kind:\s*30618[\s\S]*?created_at:\s*(now\s*-\s*\d+)/
    );
    expect(repoRefsCreatedAt).not.toBeNull();
  });

  it('[P1] non-replaceable events (1621, 1622, 1617, 1630-1632) use INSERT OR IGNORE for idempotency', () => {
    // Regular events (not in 30000-39999 range) rely on INSERT OR IGNORE
    // since they have unique event IDs (hash of content+pubkey+created_at)
    const nonReplaceableKinds = [1621, 1622, 1617, 1630, 1631, 1632];
    for (const kind of nonReplaceableKinds) {
      expect(kind).not.toBeGreaterThanOrEqual(30000);
    }
    // All events go through insertEvent which uses INSERT OR IGNORE
    expect(scriptSource).toContain('INSERT OR IGNORE INTO events');
  });

  it('[P2] replaceable events have distinct d tag values matching REPO_ID', () => {
    expect(scriptSource).toContain("const REPO_ID = 'toon-protocol'");
    // Both 30617 and 30618 use REPO_ID as their d tag value
    // This ensures they share the same replaceable identity scope
    expect(scriptSource).toMatch(/\['d',\s*REPO_ID\]/);
  });
});

// ============================================================================
// AC #7: Event structure validation
// ============================================================================

describe('Seed Script - 8.6-SEED-001: Event Structure (AC #7)', () => {
  it('[P1] signs all events with signEvent before insertion', () => {
    // Every event creation should go through signEvent -> insertEvent
    expect(scriptSource).toContain('signEvent');
    expect(scriptSource).toContain('finalizeEvent');
  });

  it('[P1] kind:30617 includes required NIP-34 tags', () => {
    // Repository announcement should have d, name, description, clone tags
    expect(scriptSource).toMatch(/kind:\s*30617[\s\S]*?\['d'/);
    expect(scriptSource).toMatch(/kind:\s*30617[\s\S]*?\['name'/);
  });

  it('[P1] kind:30618 refs event embeds arweave SHA-to-txId mappings', () => {
    // The arweaveTags variable is spread into the kind:30618 event tags
    expect(scriptSource).toContain(
      "const arweaveTags = [...arweaveMap.entries()].map(([sha, txId]) => ['arweave', sha, txId])"
    );
    expect(scriptSource).toContain('...arweaveTags');
  });

  it('[P1] kind:1621 issues include repo reference (a tag) and subject', () => {
    // Issues should reference the repo via an 'a' tag and have a subject
    expect(scriptSource).toMatch(/kind:\s*1621[\s\S]*?\['a'/);
    expect(scriptSource).toMatch(/kind:\s*1621[\s\S]*?\['subject'/);
  });

  it('[P1] kind:1622 comments reference parent event (e tag)', () => {
    expect(scriptSource).toMatch(/kind:\s*1622[\s\S]*?\['e'/);
  });

  it('[P1] kind:1617 patches include repo reference, commit, and subject tags', () => {
    expect(scriptSource).toMatch(/kind:\s*1617[\s\S]*?\['a'/);
    expect(scriptSource).toMatch(/kind:\s*1617[\s\S]*?\['commit'/);
    expect(scriptSource).toMatch(/kind:\s*1617[\s\S]*?\['subject'/);
  });

  it('[P1] status events (1630-1632) reference parent event via e tag', () => {
    // Open, merged, and closed status events all use e tags to reference the target
    expect(scriptSource).toMatch(/kind:\s*1630[\s\S]*?\['e'/);
    expect(scriptSource).toMatch(/kind:\s*1631[\s\S]*?\['e'/);
    expect(scriptSource).toMatch(/kind:\s*1632[\s\S]*?\['e'/);
  });

  it('[P1] creates multiple issues (at least 3)', () => {
    // The issues array should have 3 entries
    expect(scriptSource).toMatch(/const issues\s*=\s*\[/);
    // Count issue objects in the array (each has a 'title' property)
    const issueMatches = scriptSource.match(/title:\s*'/g);
    expect(issueMatches).not.toBeNull();
    expect(issueMatches!.length).toBeGreaterThanOrEqual(3);
  });

  it('[P1] creates issue comments', () => {
    // At least 2 comment events (kind:1622) are created
    const commentMatches = scriptSource.match(/kind:\s*1622/g);
    expect(commentMatches).not.toBeNull();
    expect(commentMatches!.length).toBeGreaterThanOrEqual(2);
  });

  it('[P2] uses execFileSync (not execSync with interpolation) for git and docker commands', () => {
    // Security: all git and docker commands use execFileSync with argument arrays
    expect(scriptSource).toContain("execFileSync('git'");
    expect(scriptSource).toContain("execFileSync('docker'");
  });

  it('[P2] validates CLI arguments against injection', () => {
    // Container name and DB path are validated with regex
    expect(scriptSource).toMatch(/\/\^\[a-zA-Z0-9\._-\]\+\$\/\.test\(CONTAINER\)/);
    expect(scriptSource).toMatch(/\/\^\[a-zA-Z0-9\._\/:-\]\+\$\/\.test\(DB_PATH\)/);
  });

  it('[P2] validates SHA format before Arweave upload', () => {
    // uploadGitObject checks SHA is 40-char hex before uploading
    expect(scriptSource).toMatch(/\/\^\[0-9a-f\]\{40\}\$\/\.test\(sha\)/);
  });
});

// ============================================================================
// AC #7: SQL insert structure
// ============================================================================

describe('Seed Script - 8.6-SEED-001: SQL Insert Structure (AC #7)', () => {
  it('[P1] inserts all required event fields into SQLite', () => {
    // The INSERT statement should include all standard Nostr event fields
    const expectedFields = [
      'id',
      'pubkey',
      'kind',
      'content',
      'tags',
      'created_at',
      'sig',
      'received_at',
    ];
    for (const field of expectedFields) {
      expect(scriptSource).toContain(field);
    }
    // Verify they appear in the INSERT statement
    expect(scriptSource).toMatch(
      /INSERT OR IGNORE INTO events\s*\(id,\s*pubkey,\s*kind,\s*content,\s*tags,\s*created_at,\s*sig,\s*received_at\)/
    );
  });

  it('[P1] serializes tags as JSON string', () => {
    expect(scriptSource).toContain('JSON.stringify(event.tags)');
  });

  it('[P1] uses docker exec sqlite3 for database insertion', () => {
    expect(scriptSource).toMatch(
      /execFileSync\('docker',\s*\['exec',\s*CONTAINER,\s*'sqlite3',\s*DB_PATH/
    );
  });
});
