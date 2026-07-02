/**
 * Tracker tests (#278): `rig issue list|show` and `rig pr list|show` against
 * a mock relay — latest-wins state derivation from kind:1630-1633, state
 * filters, comments under show, the full patch text under `pr show`, and
 * tolerance for the devnet relay's double-JSON-encoded EVENT payloads.
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '../remote-state.js';
import type { CliIo } from './output.js';
import {
  filterEvents,
  makeMockRelayFactory,
  type PayloadEncoding,
} from './read-testkit.js';
import type { ReadCommandDeps } from './read-seams.js';
import {
  deriveStatus,
  runIssueList,
  runIssueShow,
  runPrList,
  runPrShow,
} from './tracker.js';

const OWNER = 'ab'.repeat(32);
const AUTHOR = 'cd'.repeat(32);
const REPO = 'demo-repo';
const A_TAG = `30617:${OWNER}:${REPO}`;
const RELAY = 'wss://relay.test.example';

const ISSUE_CLOSED_ID = '11'.repeat(32);
const ISSUE_OPEN_ID = '22'.repeat(32);
const PR_APPLIED_ID = '33'.repeat(32);
const PR_OPEN_ID = '44'.repeat(32);
const COMMENT_ID = '55'.repeat(32);

const PATCH_TEXT = `From ${'9a'.repeat(20)} Mon Sep 17 00:00:00 2001
From: Fixture <fixture@test>
Subject: [PATCH] add feature

---
 code.txt | 1 +
 1 file changed, 1 insertion(+)
`;

function event(
  overrides: Partial<NostrEvent> & { id: string; kind: number }
): NostrEvent {
  return {
    pubkey: AUTHOR,
    created_at: 1000,
    tags: [],
    content: '',
    sig: 'f0'.repeat(64),
    ...overrides,
  };
}

const EVENTS: NostrEvent[] = [
  event({
    id: ISSUE_CLOSED_ID,
    kind: 1621,
    created_at: 1100,
    tags: [
      ['a', A_TAG],
      ['subject', 'CLI has no read path'],
      ['t', 'ux-study'],
    ],
    content: 'A second contributor cannot bootstrap the repo.',
  }),
  event({
    id: ISSUE_OPEN_ID,
    kind: 1621,
    created_at: 1200,
    tags: [
      ['a', A_TAG],
      ['subject', 'Still open issue'],
    ],
    content: 'Open body.',
  }),
  // Status history for the closed issue: opened, then closed LATER (latest wins).
  event({
    id: 'a1'.repeat(32),
    kind: 1630,
    created_at: 1150,
    tags: [
      ['e', ISSUE_CLOSED_ID],
      ['a', A_TAG],
    ],
  }),
  event({
    id: 'a2'.repeat(32),
    kind: 1632,
    created_at: 1300,
    tags: [
      ['e', ISSUE_CLOSED_ID],
      ['a', A_TAG],
    ],
  }),
  event({
    id: PR_APPLIED_ID,
    kind: 1617,
    created_at: 1400,
    tags: [
      ['a', A_TAG],
      ['subject', 'Add feature'],
      ['branch', 'feature'],
      ['commit', '9a'.repeat(20)],
      // `rig pr create --body` (#280): the PR body rides in a description
      // tag so `content` stays pure format-patch for `git am`.
      ['description', 'Why: the feature was missing.'],
    ],
    content: PATCH_TEXT,
  }),
  event({
    id: PR_OPEN_ID,
    kind: 1617,
    created_at: 1500,
    tags: [
      ['a', A_TAG],
      ['subject', 'Pending patch'],
    ],
    content: 'From abc patch',
  }),
  // The applied PR's status carries NO `a` tag (other clients do this) —
  // reachable only through the follow-up `#e` query.
  event({
    id: 'a3'.repeat(32),
    kind: 1631,
    created_at: 1450,
    tags: [['e', PR_APPLIED_ID]],
  }),
  // Comment on the closed issue.
  event({
    id: COMMENT_ID,
    kind: 1622,
    created_at: 1350,
    tags: [
      ['e', ISSUE_CLOSED_ID],
      ['a', A_TAG],
    ],
    content: 'Nice catch — fixing in #278.',
  }),
];

interface TestIo extends CliIo {
  outLines: string[];
  errLines: string[];
  jsonDocs: unknown[];
}

function makeTestIo(): TestIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const jsonDocs: unknown[] = [];
  return {
    outLines,
    errLines,
    jsonDocs,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
    emitJson: (payload) => jsonDocs.push(payload),
    isInteractive: false,
    confirm: async () => false,
  };
}

function makeDeps(
  io: TestIo,
  encoding: PayloadEncoding = 'object',
  events: NostrEvent[] = EVENTS
): ReadCommandDeps {
  return {
    io,
    env: {},
    cwd: '/nonexistent-not-a-repo',
    webSocketFactory: makeMockRelayFactory(
      (filter) => filterEvents(events, filter),
      encoding
    ),
  };
}

const ADDR_FLAGS = ['--repo-id', REPO, '--owner', OWNER, '--relay', RELAY];

// ---------------------------------------------------------------------------
// deriveStatus (latest-wins)
// ---------------------------------------------------------------------------

describe('deriveStatus', () => {
  it('defaults to open with no status events', () => {
    expect(deriveStatus(ISSUE_OPEN_ID, EVENTS)).toBe('open');
  });

  it('latest status wins (a later close beats an earlier open)', () => {
    expect(deriveStatus(ISSUE_CLOSED_ID, EVENTS)).toBe('closed');
  });

  it('a re-open AFTER a close wins again', () => {
    const reopened = [
      ...EVENTS,
      event({
        id: 'a4'.repeat(32),
        kind: 1630,
        created_at: 1400,
        tags: [['e', ISSUE_CLOSED_ID]],
      }),
    ];
    expect(deriveStatus(ISSUE_CLOSED_ID, reopened)).toBe('open');
  });

  it('created_at ties break on the LOWEST event id', () => {
    const tied = [
      event({
        id: 'ff'.repeat(32),
        kind: 1630,
        created_at: 2000,
        tags: [['e', ISSUE_CLOSED_ID]],
      }),
      event({
        id: '00'.repeat(32),
        kind: 1632,
        created_at: 2000,
        tags: [['e', ISSUE_CLOSED_ID]],
      }),
    ];
    expect(deriveStatus(ISSUE_CLOSED_ID, tied)).toBe('closed');
  });

  it('ignores statuses that reference other events', () => {
    expect(deriveStatus(PR_OPEN_ID, EVENTS)).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// issue list
// ---------------------------------------------------------------------------

describe('rig issue list', () => {
  it('lists issues with derived state (default: all, newest first)', async () => {
    const io = makeTestIo();
    const code = await runIssueList([...ADDR_FLAGS, '--json'], makeDeps(io));
    expect(code).toBe(0);
    const doc = io.jsonDocs[0] as {
      issues: { eventId: string; status: string }[];
    };
    expect(doc).toMatchObject({ command: 'issue list', count: 2 });
    expect(doc.issues.map((i) => [i.eventId, i.status])).toEqual([
      [ISSUE_OPEN_ID, 'open'],
      [ISSUE_CLOSED_ID, 'closed'],
    ]);
  });

  it('filters by --state', async () => {
    const io = makeTestIo();
    const code = await runIssueList(
      [...ADDR_FLAGS, '--state', 'closed', '--json'],
      makeDeps(io)
    );
    expect(code).toBe(0);
    const doc = io.jsonDocs[0] as { issues: { eventId: string }[] };
    expect(doc.issues.map((i) => i.eventId)).toEqual([ISSUE_CLOSED_ID]);
  });

  it('tolerates the devnet relay double-JSON EVENT encoding', async () => {
    const io = makeTestIo();
    const code = await runIssueList(
      [...ADDR_FLAGS, '--json'],
      makeDeps(io, 'double-json')
    );
    expect(code).toBe(0);
    expect((io.jsonDocs[0] as { count: number }).count).toBe(2);
  });

  it('renders a human table without --json', async () => {
    const io = makeTestIo();
    const code = await runIssueList(ADDR_FLAGS, makeDeps(io));
    expect(code).toBe(0);
    const text = io.outLines.join('\n');
    expect(text).toContain('closed');
    expect(text).toContain('CLI has no read path');
    expect(text).toContain('[ux-study]');
  });

  it('requires the repo address', async () => {
    const io = makeTestIo();
    const code = await runIssueList(['--relay', RELAY, '--json'], makeDeps(io));
    expect(code).toBe(1);
    expect(io.jsonDocs[0]).toMatchObject({
      error: 'unconfigured_repo_address',
    });
  });

  it('rejects an invalid --state', async () => {
    const io = makeTestIo();
    const code = await runIssueList(
      [...ADDR_FLAGS, '--state', 'bogus'],
      makeDeps(io)
    );
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// issue show
// ---------------------------------------------------------------------------

describe('rig issue show', () => {
  it('shows metadata, derived state, body, and comments', async () => {
    const io = makeTestIo();
    const code = await runIssueShow(
      [ISSUE_CLOSED_ID, '--relay', RELAY, '--json'],
      makeDeps(io)
    );
    expect(code).toBe(0);
    const doc = io.jsonDocs[0] as Record<string, unknown>;
    expect(doc).toMatchObject({
      command: 'issue show',
      repoATag: A_TAG,
      issue: {
        eventId: ISSUE_CLOSED_ID,
        title: 'CLI has no read path',
        status: 'closed',
        authorPubkey: AUTHOR,
      },
    });
    expect(doc['comments']).toEqual([
      expect.objectContaining({
        eventId: COMMENT_ID,
        content: 'Nice catch — fixing in #278.',
      }),
    ]);
  });

  it('errors when the id is not on the relay', async () => {
    const io = makeTestIo();
    const code = await runIssueShow(
      ['66'.repeat(32), '--relay', RELAY, '--json'],
      makeDeps(io)
    );
    expect(code).toBe(1);
    expect(io.errLines.join('\n')).toContain('not found');
  });

  it('redirects a patch id to `rig pr show`', async () => {
    const io = makeTestIo();
    const code = await runIssueShow(
      [PR_APPLIED_ID, '--relay', RELAY],
      makeDeps(io)
    );
    expect(code).toBe(1);
    expect(io.errLines.join('\n')).toContain('rig pr show');
  });
});

// ---------------------------------------------------------------------------
// pr list / show
// ---------------------------------------------------------------------------

describe('rig pr list/show', () => {
  it('lists PRs with statuses derived through the `#e` fallback query', async () => {
    const io = makeTestIo();
    const code = await runPrList([...ADDR_FLAGS, '--json'], makeDeps(io));
    expect(code).toBe(0);
    const doc = io.jsonDocs[0] as {
      prs: { eventId: string; status: string }[];
    };
    expect(doc).toMatchObject({ command: 'pr list', count: 2 });
    expect(doc.prs.map((p) => [p.eventId, p.status])).toEqual([
      [PR_OPEN_ID, 'open'],
      [PR_APPLIED_ID, 'applied'], // status event had no `a` tag
    ]);
  });

  it('filters by --state applied', async () => {
    const io = makeTestIo();
    const code = await runPrList(
      [...ADDR_FLAGS, '--state', 'applied', '--json'],
      makeDeps(io)
    );
    expect(code).toBe(0);
    expect((io.jsonDocs[0] as { prs: unknown[] }).prs).toHaveLength(1);
  });

  it('pr show prints the FULL patch text plus commit/branch metadata', async () => {
    const io = makeTestIo();
    const code = await runPrShow(
      [PR_APPLIED_ID, '--relay', RELAY],
      makeDeps(io)
    );
    expect(code).toBe(0);
    const text = io.outLines.join('\n');
    expect(text).toContain('Status:  applied');
    expect(text).toContain('Branch:  feature');
    expect(text).toContain(`Commits: ${'9a'.repeat(20)}`);
    expect(text).toContain('Subject: [PATCH] add feature'); // verbatim patch
    // #280: the description tag renders as its own Body section, ABOVE the
    // patch text (which stays verbatim below it).
    expect(text).toContain('Body:');
    expect(text).toContain('Why: the feature was missing.');
    expect(text.indexOf('Why: the feature was missing.')).toBeLessThan(
      text.indexOf('Subject: [PATCH] add feature')
    );
  });

  it('pr show without a description tag prints no Body section', async () => {
    const io = makeTestIo();
    const code = await runPrShow([PR_OPEN_ID, '--relay', RELAY], makeDeps(io));
    expect(code).toBe(0);
    expect(io.outLines.join('\n')).not.toContain('Body:');
  });

  it('pr show --json carries the patch content for `git am` piping', async () => {
    const io = makeTestIo();
    const code = await runPrShow(
      [PR_APPLIED_ID, '--relay', RELAY, '--json'],
      makeDeps(io)
    );
    expect(code).toBe(0);
    expect(io.jsonDocs[0]).toMatchObject({
      command: 'pr show',
      pr: expect.objectContaining({
        content: PATCH_TEXT, // untouched — pipeable into `git am`
        status: 'applied',
        description: 'Why: the feature was missing.',
      }),
    });
  });
});
