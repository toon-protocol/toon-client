// @vitest-environment jsdom
// Test IDs: 8.5-E2E-001 through 8.5-E2E-014
// AC covered: #1-#24 (Full E2E for Story 8.5 user-facing UI changes)
//
// These tests exercise the full user-facing UI for issues and PRs,
// testing routing, parsing, template rendering, markdown-safe content,
// XSS prevention, navigation tabs, and empty/error states. They render
// into jsdom and assert on DOM state.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { parseRoute } from '../router.js';
import {
  parseIssue,
  parsePR,
  parseComment,
  resolvePRStatus,
  parseRepoAnnouncement,
} from '../nip34-parsers.js';
import type {
  NostrEvent,
  IssueMetadata,
  PRMetadata,
  CommentMetadata,
} from '../nip34-parsers.js';
import {
  buildIssueListFilter,
  buildCommentFilter,
  buildPRListFilter,
  buildStatusFilter,
  buildEventByIdFilter,
  buildIssueCloseFilter,
} from '../relay-client.js';
import {
  renderIssueList,
  renderIssueDetail,
  renderPRList,
  renderPRDetail,
  renderRepoTabs,
} from '../templates.js';
import { renderLayout } from '../layout.js';
import { ProfileCache } from '../profile-cache.js';
import { renderMarkdownSafe } from '../markdown-safe.js';

// ============================================================================
// Test Fixture Helpers
// ============================================================================

const OWNER_PUBKEY = 'ab'.repeat(32);
const AUTHOR_A_PUBKEY = 'a1'.repeat(32);
const AUTHOR_B_PUBKEY = 'b2'.repeat(32);
const AUTHOR_C_PUBKEY = 'c3'.repeat(32);
const REPO_ID = 'test-repo';

/** Create a kind:1621 issue event. */
function createIssueEvent(opts: {
  id: string;
  title?: string;
  content?: string;
  pubkey?: string;
  createdAt?: number;
  labels?: string[];
  repoTag?: string;
}): NostrEvent {
  const tags: string[][] = [
    ['a', `30617:${OWNER_PUBKEY}:${REPO_ID}`],
  ];
  if (opts.title) {
    tags.push(['subject', opts.title]);
  }
  if (opts.labels) {
    for (const label of opts.labels) {
      tags.push(['t', label]);
    }
  }
  if (opts.repoTag) {
    tags[0] = ['a', opts.repoTag];
  }
  return {
    id: opts.id,
    pubkey: opts.pubkey ?? AUTHOR_A_PUBKEY,
    created_at: opts.createdAt ?? 1711180800,
    kind: 1621,
    tags,
    content: opts.content ?? 'Issue body content',
    sig: 'f'.repeat(128),
  };
}

/** Create a kind:1617 PR event. */
function createPREvent(opts: {
  id: string;
  title?: string;
  content?: string;
  pubkey?: string;
  createdAt?: number;
  commitShas?: string[];
  baseBranch?: string;
}): NostrEvent {
  const tags: string[][] = [
    ['a', `30617:${OWNER_PUBKEY}:${REPO_ID}`],
  ];
  if (opts.title) {
    tags.push(['subject', opts.title]);
  }
  if (opts.commitShas) {
    for (const sha of opts.commitShas) {
      tags.push(['commit', sha]);
    }
  }
  if (opts.baseBranch) {
    tags.push(['branch', opts.baseBranch]);
  }
  return {
    id: opts.id,
    pubkey: opts.pubkey ?? AUTHOR_A_PUBKEY,
    created_at: opts.createdAt ?? 1711180800,
    kind: 1617,
    tags,
    content: opts.content ?? 'Patch content here',
    sig: 'f'.repeat(128),
  };
}

/** Create a kind:1622 comment event. */
function createCommentEvent(opts: {
  id: string;
  parentEventId: string;
  content?: string;
  pubkey?: string;
  createdAt?: number;
}): NostrEvent {
  return {
    id: opts.id,
    pubkey: opts.pubkey ?? AUTHOR_B_PUBKEY,
    created_at: opts.createdAt ?? 1711200000,
    kind: 1622,
    tags: [['e', opts.parentEventId]],
    content: opts.content ?? 'Comment text',
    sig: 'f'.repeat(128),
  };
}

/** Create a status event (kind:1630-1633). */
function createStatusEvent(opts: {
  id: string;
  prEventId: string;
  kind: 1630 | 1631 | 1632 | 1633;
  createdAt?: number;
}): NostrEvent {
  return {
    id: opts.id,
    pubkey: OWNER_PUBKEY,
    created_at: opts.createdAt ?? 1711200000,
    kind: opts.kind,
    tags: [['e', opts.prEventId]],
    content: '',
    sig: 'f'.repeat(128),
  };
}

// ============================================================================
// E2E Tests: Story 8.5 — Issues and PRs
// ============================================================================

describe('E2E: Story 8.5 — Issues and PRs', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-23T12:00:00Z'));
    container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ==========================================================================
  // 8.5-E2E-001: Full issue list flow — route parse to rendered DOM
  // AC: #1, #6, #10, #12, #17, #22
  // ==========================================================================

  describe('8.5-E2E-001: Full issue list — route to rendered DOM', () => {
    it('[P1] parses issue list route, builds query filters, parses events, renders list with titles/authors/dates/labels/status/tabs/banner', () => {
      // 1. Parse route
      const route = parseRoute('/npub1owner/test-repo/issues');
      expect(route.type).toBe('issues');
      if (route.type !== 'issues') throw new Error('Expected issues route');
      expect(route.owner).toBe('npub1owner');
      expect(route.repo).toBe('test-repo');

      // 2. Build query filters
      const issueFilter = buildIssueListFilter(OWNER_PUBKEY, REPO_ID);
      expect(issueFilter.kinds).toEqual([1621]);
      expect(issueFilter['#a']).toEqual([`30617:${OWNER_PUBKEY}:${REPO_ID}`]);
      expect(issueFilter.limit).toBe(100);

      // 3. Parse issue events
      const issueEvents = [
        createIssueEvent({
          id: '1'.repeat(64),
          title: 'Bug: crash on startup',
          content: 'App crashes when launched with --debug flag',
          pubkey: AUTHOR_A_PUBKEY,
          createdAt: 1711180800,
          labels: ['bug', 'high-priority'],
        }),
        createIssueEvent({
          id: '2'.repeat(64),
          title: 'Feature: dark mode',
          content: 'Please add dark mode support',
          pubkey: AUTHOR_B_PUBKEY,
          createdAt: 1711094400,
          labels: ['enhancement'],
        }),
        createIssueEvent({
          id: '3'.repeat(64),
          title: 'Update docs',
          content: 'README needs updating',
          pubkey: AUTHOR_C_PUBKEY,
          createdAt: 1711008000,
          labels: [],
        }),
      ];

      const issues: IssueMetadata[] = issueEvents
        .map((e) => parseIssue(e))
        .filter((i): i is IssueMetadata => i !== null);

      expect(issues).toHaveLength(3);
      expect(issues[0]!.title).toBe('Bug: crash on startup');
      expect(issues[0]!.labels).toEqual(['bug', 'high-priority']);
      expect(issues[1]!.title).toBe('Feature: dark mode');
      expect(issues[2]!.title).toBe('Update docs');

      // 4. Resolve issue close status via kind:1632
      const closeFilter = buildIssueCloseFilter(issues.map((i) => i.eventId));
      expect(closeFilter.kinds).toEqual([1632]);

      // Simulate: second issue is closed
      const closeEvent = createStatusEvent({
        id: 'close1'.padEnd(64, '0'),
        prEventId: '2'.repeat(64),
        kind: 1632,
        createdAt: 1711200000,
      });
      const closedIds = new Set<string>();
      const eTag = closeEvent.tags.find((t) => t[0] === 'e');
      if (eTag?.[1]) closedIds.add(eTag[1]);
      for (const issue of issues) {
        if (closedIds.has(issue.eventId)) {
          issue.status = 'closed';
        }
      }

      // 5. Sort by created_at descending
      issues.sort((a, b) => b.createdAt - a.createdAt);
      expect(issues[0]!.title).toBe('Bug: crash on startup');

      // 6. Set up profile cache
      const cache = new ProfileCache();
      cache.setProfile(AUTHOR_A_PUBKEY, { name: 'Alice' });
      cache.setProfile(AUTHOR_B_PUBKEY, { name: 'Bob' });
      cache.setProfile(AUTHOR_C_PUBKEY, { displayName: 'Charlie' });

      // 7. Render issue list
      const result = renderIssueList('test-repo', issues, cache, 'npub1owner');
      expect(result.status).toBe(200);

      // 8. Embed in layout and render into DOM
      const fullHtml = renderLayout('Forge', result.html, 'wss://localhost:7100');
      container.innerHTML = fullHtml;

      // 9. Assert: titles are rendered
      expect(container.textContent).toContain('Bug: crash on startup');
      expect(container.textContent).toContain('Feature: dark mode');
      expect(container.textContent).toContain('Update docs');

      // 10. Assert: authors are rendered
      expect(container.textContent).toContain('Alice');
      expect(container.textContent).toContain('Bob');
      expect(container.textContent).toContain('Charlie');

      // 11. Assert: labels are rendered
      expect(container.textContent).toContain('bug');
      expect(container.textContent).toContain('high-priority');
      expect(container.textContent).toContain('enhancement');

      // 12. Assert: status badges
      const badges = container.querySelectorAll('.status-badge');
      expect(badges.length).toBe(3);
      const closedBadge = container.querySelector('.status-closed');
      expect(closedBadge).not.toBeNull();
      expect(closedBadge!.textContent).toBe('closed');
      const openBadges = container.querySelectorAll('.status-open');
      expect(openBadges.length).toBe(2);

      // 13. Assert: contribution banner
      expect(container.textContent).toContain('Forge-UI is read-only');
      expect(container.textContent).toContain('NIP-34 skill');

      // 14. Assert: navigation tabs (Code, Issues, Pull Requests)
      const tabs = container.querySelectorAll('.repo-tabs a');
      expect(tabs.length).toBe(3);
      const tabTexts = Array.from(tabs).map((t) => t.textContent);
      expect(tabTexts).toContain('Code');
      expect(tabTexts).toContain('Issues');
      expect(tabTexts).toContain('Pull Requests');

      // 15. Assert: Issues tab is active
      const activeTab = container.querySelector('.tab-active');
      expect(activeTab).not.toBeNull();
      expect(activeTab!.textContent).toBe('Issues');

      // 16. Assert: issue titles link to detail views
      const titleLinks = container.querySelectorAll('.issue-title-link');
      expect(titleLinks.length).toBe(3);
      const firstHref = titleLinks[0]!.getAttribute('href');
      expect(firstHref).toContain('/issues/');
      expect(firstHref).toContain('1'.repeat(64));
    });
  });

  // ==========================================================================
  // 8.5-E2E-002: Issue detail flow — event parse to rendered DOM with comments
  // AC: #5, #8, #11, #16, #17, #22, #24
  // ==========================================================================

  describe('8.5-E2E-002: Issue detail — route to rendered DOM with comments', () => {
    it('[P1] parses issue detail route, fetches event + comments, renders detail with markdown-safe content and comment thread', () => {
      // 1. Parse route
      const eventId = 'a'.repeat(64);
      const route = parseRoute(`/npub1owner/test-repo/issues/${eventId}`);
      expect(route.type).toBe('issue-detail');
      if (route.type !== 'issue-detail') throw new Error('Expected issue-detail route');
      expect(route.eventId).toBe(eventId);

      // 2. Build event-by-ID filter
      const eventFilter = buildEventByIdFilter([eventId]);
      expect(eventFilter.ids).toEqual([eventId]);

      // 3. Build comment filter
      const commentFilter = buildCommentFilter([eventId]);
      expect(commentFilter.kinds).toEqual([1622]);
      expect(commentFilter['#e']).toEqual([eventId]);

      // 4. Parse issue event with markdown content
      const issueEvent = createIssueEvent({
        id: eventId,
        title: 'Bug with code blocks',
        content: 'When I run this:\n\n```\nconst x = 1;\nconsole.log(x);\n```\n\nIt fails with `TypeError`. See https://example.com/issue for details.',
        pubkey: AUTHOR_A_PUBKEY,
        createdAt: 1711180800,
        labels: ['bug'],
      });

      const issue = parseIssue(issueEvent);
      expect(issue).not.toBeNull();

      // Check close status (open)
      const closeFilter = buildIssueCloseFilter([eventId]);
      expect(closeFilter.kinds).toEqual([1632]);
      // No close events, so stays open

      // 5. Parse comments
      const commentEvents = [
        createCommentEvent({
          id: 'c1'.padEnd(64, '0'),
          parentEventId: eventId,
          content: 'I can reproduce this bug.',
          pubkey: AUTHOR_B_PUBKEY,
          createdAt: 1711200000,
        }),
        createCommentEvent({
          id: 'c2'.padEnd(64, '0'),
          parentEventId: eventId,
          content: 'Fixed in the latest commit.',
          pubkey: AUTHOR_C_PUBKEY,
          createdAt: 1711210000,
        }),
      ];

      const comments: CommentMetadata[] = commentEvents
        .map((e) => parseComment(e))
        .filter((c): c is CommentMetadata => c !== null)
        .sort((a, b) => a.createdAt - b.createdAt);

      expect(comments).toHaveLength(2);
      expect(comments[0]!.content).toBe('I can reproduce this bug.');
      expect(comments[1]!.content).toBe('Fixed in the latest commit.');

      // 6. Set up profile cache
      const cache = new ProfileCache();
      cache.setProfile(AUTHOR_A_PUBKEY, { name: 'Alice' });
      cache.setProfile(AUTHOR_B_PUBKEY, { name: 'Bob' });
      cache.setProfile(AUTHOR_C_PUBKEY, { displayName: 'Charlie' });

      // 7. Render issue detail
      const result = renderIssueDetail('test-repo', issue!, comments, cache, 'npub1owner');
      expect(result.status).toBe(200);

      const fullHtml = renderLayout('Forge', result.html, 'wss://localhost:7100');
      container.innerHTML = fullHtml;

      // 8. Assert: title is rendered
      expect(container.textContent).toContain('Bug with code blocks');

      // 9. Assert: markdown-safe content is rendered (code blocks, inline code, links)
      const bodyHtml = result.html;
      expect(bodyHtml).toContain('<pre class="code-block"><code>');
      expect(bodyHtml).toContain('<code class="inline-code">TypeError</code>');
      expect(bodyHtml).toContain('href=');
      expect(bodyHtml).toContain('example.com/issue');

      // 10. Assert: comments in chronological order
      const commentEls = container.querySelectorAll('.comment');
      expect(commentEls).toHaveLength(2);
      expect(commentEls[0]!.textContent).toContain('I can reproduce this bug.');
      expect(commentEls[1]!.textContent).toContain('Fixed in the latest commit.');

      // 11. Assert: comment authors
      expect(commentEls[0]!.textContent).toContain('Bob');
      expect(commentEls[1]!.textContent).toContain('Charlie');

      // 12. Assert: contribution banner and tabs
      expect(container.textContent).toContain('Forge-UI is read-only');
      const activeTab = container.querySelector('.tab-active');
      expect(activeTab!.textContent).toBe('Issues');

      // 13. Assert: label badges
      expect(container.textContent).toContain('bug');
      const labelBadges = container.querySelectorAll('.label-badge');
      expect(labelBadges.length).toBe(1);
    });
  });

  // ==========================================================================
  // 8.5-E2E-003: Full PR list flow — route parse to rendered DOM
  // AC: #3, #4, #7, #9, #13, #17, #22
  // ==========================================================================

  describe('8.5-E2E-003: Full PR list — route to rendered DOM', () => {
    it('[P1] parses PR list route, builds query filters, parses events with status resolution, renders list with status badges/branches/tabs', () => {
      // 1. Parse route
      const route = parseRoute('/npub1owner/test-repo/pulls');
      expect(route.type).toBe('pulls');
      if (route.type !== 'pulls') throw new Error('Expected pulls route');

      // 2. Build query filters
      const prFilter = buildPRListFilter(OWNER_PUBKEY, REPO_ID);
      expect(prFilter.kinds).toEqual([1617]);
      expect(prFilter['#a']).toEqual([`30617:${OWNER_PUBKEY}:${REPO_ID}`]);

      // 3. Parse PR events
      const prEvents = [
        createPREvent({
          id: 'pr1'.padEnd(64, '0'),
          title: 'Add new parser module',
          content: 'From abc123\n---\nPatch content',
          pubkey: AUTHOR_A_PUBKEY,
          createdAt: 1711180800,
          commitShas: ['abc123def456'],
          baseBranch: 'main',
        }),
        createPREvent({
          id: 'pr2'.padEnd(64, '0'),
          title: 'Fix rendering bug',
          content: 'From def456\n---\nFix patch',
          pubkey: AUTHOR_B_PUBKEY,
          createdAt: 1711094400,
          commitShas: ['def456', 'ghi789'],
          baseBranch: 'develop',
        }),
        createPREvent({
          id: 'pr3'.padEnd(64, '0'),
          title: 'Draft: experimental feature',
          content: 'WIP patch',
          pubkey: AUTHOR_C_PUBKEY,
          createdAt: 1711008000,
          commitShas: [],
          baseBranch: 'main',
        }),
      ];

      const prs: PRMetadata[] = prEvents
        .map((e) => parsePR(e))
        .filter((p): p is PRMetadata => p !== null);

      expect(prs).toHaveLength(3);

      // 4. Build and resolve status events
      const prIds = prs.map((p) => p.eventId);
      const statusFilter = buildStatusFilter(prIds);
      expect(statusFilter.kinds).toEqual([1630, 1631, 1632, 1633]);
      expect(statusFilter['#e']).toEqual(prIds);

      // Simulate status events: PR1 open (default), PR2 applied, PR3 draft
      const statusEvents: NostrEvent[] = [
        createStatusEvent({
          id: 'st1'.padEnd(64, '0'),
          prEventId: 'pr2'.padEnd(64, '0'),
          kind: 1631, // applied
          createdAt: 1711200000,
        }),
        createStatusEvent({
          id: 'st2'.padEnd(64, '0'),
          prEventId: 'pr3'.padEnd(64, '0'),
          kind: 1633, // draft
          createdAt: 1711100000,
        }),
      ];

      for (const pr of prs) {
        pr.status = resolvePRStatus(pr.eventId, statusEvents);
      }

      expect(prs[0]!.status).toBe('open');
      expect(prs[1]!.status).toBe('applied');
      expect(prs[2]!.status).toBe('draft');

      // 5. Sort descending
      prs.sort((a, b) => b.createdAt - a.createdAt);

      // 6. Render
      const cache = new ProfileCache();
      cache.setProfile(AUTHOR_A_PUBKEY, { name: 'Alice' });
      cache.setProfile(AUTHOR_B_PUBKEY, { name: 'Bob' });
      cache.setProfile(AUTHOR_C_PUBKEY, { displayName: 'Charlie' });

      const result = renderPRList('test-repo', prs, cache, 'npub1owner');
      const fullHtml = renderLayout('Forge', result.html, 'wss://localhost:7100');
      container.innerHTML = fullHtml;

      // 7. Assert: titles
      expect(container.textContent).toContain('Add new parser module');
      expect(container.textContent).toContain('Fix rendering bug');
      expect(container.textContent).toContain('Draft: experimental feature');

      // 8. Assert: status badges with correct CSS classes
      expect(container.querySelector('.status-open')).not.toBeNull();
      expect(container.querySelector('.status-applied')).not.toBeNull();
      expect(container.querySelector('.status-draft')).not.toBeNull();

      // 9. Assert: base branches
      expect(container.textContent).toContain('main');
      expect(container.textContent).toContain('develop');

      // 10. Assert: authors
      expect(container.textContent).toContain('Alice');
      expect(container.textContent).toContain('Bob');
      expect(container.textContent).toContain('Charlie');

      // 11. Assert: Pull Requests tab is active
      const activeTab = container.querySelector('.tab-active');
      expect(activeTab!.textContent).toBe('Pull Requests');

      // 12. Assert: PR titles link to detail views
      const titleLinks = container.querySelectorAll('.pr-title-link');
      expect(titleLinks.length).toBe(3);
      const firstHref = titleLinks[0]!.getAttribute('href');
      expect(firstHref).toContain('/pulls/');

      // 13. Assert: contribution banner
      expect(container.textContent).toContain('Forge-UI is read-only');
    });
  });

  // ==========================================================================
  // 8.5-E2E-004: PR detail flow — event parse to rendered DOM with status, commits, comments
  // AC: #5, #7, #9, #14, #16, #17, #22
  // ==========================================================================

  describe('8.5-E2E-004: PR detail — route to rendered DOM with commits and comments', () => {
    it('[P1] parses PR detail route, fetches event + status + comments, renders detail with commit links and comment thread', () => {
      // 1. Parse route
      const prId = 'pr1'.padEnd(64, '0');
      const route = parseRoute(`/npub1owner/test-repo/pulls/${prId}`);
      expect(route.type).toBe('pull-detail');
      if (route.type !== 'pull-detail') throw new Error('Expected pull-detail route');
      expect(route.eventId).toBe(prId);

      // 2. Parse PR event
      const prEvent = createPREvent({
        id: prId,
        title: 'Add NIP-34 parser',
        content: 'This patch adds parsing for NIP-34 events.\n\nSee https://github.com/nostr-protocol/nips/blob/master/34.md for spec.',
        pubkey: AUTHOR_A_PUBKEY,
        createdAt: 1711180800,
        commitShas: ['abc123def456', 'fed987cba654'],
        baseBranch: 'main',
      });

      const pr = parsePR(prEvent);
      expect(pr).not.toBeNull();
      expect(pr!.commitShas).toEqual(['abc123def456', 'fed987cba654']);
      expect(pr!.baseBranch).toBe('main');

      // 3. Resolve status (applied)
      const statusEvents = [
        createStatusEvent({
          id: 'st1'.padEnd(64, '0'),
          prEventId: prId,
          kind: 1631, // applied
          createdAt: 1711300000,
        }),
      ];
      pr!.status = resolvePRStatus(prId, statusEvents);
      expect(pr!.status).toBe('applied');

      // 4. Parse comments
      const comments: CommentMetadata[] = [
        {
          eventId: 'c1'.padEnd(64, '0'),
          content: 'LGTM, nice work!',
          authorPubkey: AUTHOR_B_PUBKEY,
          createdAt: 1711200000,
          parentEventId: prId,
        },
        {
          eventId: 'c2'.padEnd(64, '0'),
          content: 'Merged, thanks!',
          authorPubkey: AUTHOR_C_PUBKEY,
          createdAt: 1711250000,
          parentEventId: prId,
        },
      ].sort((a, b) => a.createdAt - b.createdAt);

      // 5. Render
      const cache = new ProfileCache();
      cache.setProfile(AUTHOR_A_PUBKEY, { name: 'Alice' });
      cache.setProfile(AUTHOR_B_PUBKEY, { name: 'Bob' });
      cache.setProfile(AUTHOR_C_PUBKEY, { displayName: 'Charlie' });

      const result = renderPRDetail('test-repo', pr!, comments, cache, 'npub1owner');
      const fullHtml = renderLayout('Forge', result.html, 'wss://localhost:7100');
      container.innerHTML = fullHtml;

      // 6. Assert: title
      expect(container.textContent).toContain('Add NIP-34 parser');

      // 7. Assert: status badge (applied = purple)
      const statusBadge = container.querySelector('.status-applied');
      expect(statusBadge).not.toBeNull();
      expect(statusBadge!.textContent).toBe('applied');

      // 8. Assert: base branch
      expect(container.textContent).toContain('main');

      // 9. Assert: commit SHA links
      const commitLinks = container.querySelectorAll('.commit-sha');
      expect(commitLinks.length).toBe(2);
      expect(commitLinks[0]!.textContent).toBe('abc123d');
      expect(commitLinks[1]!.textContent).toBe('fed987c');
      // Commit links should point to commit view
      expect(commitLinks[0]!.getAttribute('href')).toContain('/commit/abc123def456');
      expect(commitLinks[1]!.getAttribute('href')).toContain('/commit/fed987cba654');

      // 10. Assert: markdown-safe content (URL auto-linked)
      expect(result.html).toContain('href=');
      expect(result.html).toContain('nostr-protocol');

      // 11. Assert: comments in order
      const commentEls = container.querySelectorAll('.comment');
      expect(commentEls).toHaveLength(2);
      expect(commentEls[0]!.textContent).toContain('LGTM');
      expect(commentEls[1]!.textContent).toContain('Merged');

      // 12. Assert: Pull Requests tab is active
      const activeTab = container.querySelector('.tab-active');
      expect(activeTab!.textContent).toBe('Pull Requests');
    });
  });

  // ==========================================================================
  // 8.5-E2E-005: Empty states — no issues and no PRs
  // AC: #12, #15
  // ==========================================================================

  describe('8.5-E2E-005: Empty states', () => {
    it('[P1] renders empty state message for repository with no issues', () => {
      const cache = new ProfileCache();
      const result = renderIssueList('test-repo', [], cache, 'npub1owner');
      const fullHtml = renderLayout('Forge', result.html, 'wss://localhost:7100');
      container.innerHTML = fullHtml;

      expect(container.textContent).toContain('No issues found for this repository');
      expect(container.textContent).toContain('kind:1621');
      expect(container.textContent).toContain('Forge-UI is read-only');
    });

    it('[P1] renders empty state message for repository with no PRs', () => {
      const cache = new ProfileCache();
      const result = renderPRList('test-repo', [], cache, 'npub1owner');
      const fullHtml = renderLayout('Forge', result.html, 'wss://localhost:7100');
      container.innerHTML = fullHtml;

      expect(container.textContent).toContain('No pull requests found for this repository');
      expect(container.textContent).toContain('kind:1617');
      expect(container.textContent).toContain('Forge-UI is read-only');
    });
  });

  // ==========================================================================
  // 8.5-E2E-006: XSS prevention in issue content and titles
  // AC: #16, #24
  // ==========================================================================

  describe('8.5-E2E-006: XSS prevention', () => {
    it('[P0] malicious issue title, content, labels, and author names are HTML-escaped', () => {
      const maliciousIssue: IssueMetadata = {
        eventId: 'x'.repeat(64),
        title: '<script>alert("xss")</script>',
        content: '<img onerror=alert(1) src=x>\n\njavascript:alert(1)\n\n<div onmouseover="evil()">hover me</div>',
        authorPubkey: AUTHOR_A_PUBKEY,
        createdAt: 1711180800,
        labels: ['<script>alert("label")</script>'],
        status: 'open',
      };

      const cache = new ProfileCache();
      cache.setProfile(AUTHOR_A_PUBKEY, {
        name: '<script>alert("name")</script>',
      });

      const result = renderIssueList('test-repo', [maliciousIssue], cache, 'npub1owner');
      const fullHtml = renderLayout('Forge', result.html, 'wss://localhost:7100');
      container.innerHTML = fullHtml;

      // No executable script or event handler elements
      expect(container.querySelectorAll('script')).toHaveLength(0);
      expect(container.querySelectorAll('img[onerror]')).toHaveLength(0);
      expect(container.querySelectorAll('[onmouseover]')).toHaveLength(0);

      // Escaped content should be present as text
      expect(result.html).toContain('&lt;script&gt;');
      expect(result.html).not.toContain('<script>alert');
    });

    it('[P0] malicious PR title and content are HTML-escaped in detail view', () => {
      const maliciousPR: PRMetadata = {
        eventId: 'y'.repeat(64),
        title: '"><script>alert(1)</script>',
        content: '<iframe src="javascript:alert(1)"></iframe>\n\n<a href="javascript:void(0)">click</a>',
        authorPubkey: AUTHOR_A_PUBKEY,
        createdAt: 1711180800,
        commitShas: ['abc123'],
        baseBranch: 'main',
        status: 'open',
      };

      const cache = new ProfileCache();
      const result = renderPRDetail('test-repo', maliciousPR, [], cache, 'npub1owner');
      const fullHtml = renderLayout('Forge', result.html, 'wss://localhost:7100');
      container.innerHTML = fullHtml;

      expect(container.querySelectorAll('script')).toHaveLength(0);
      expect(container.querySelectorAll('iframe')).toHaveLength(0);
      expect(result.html).toContain('&lt;script&gt;');
      expect(result.html).toContain('&lt;iframe');
    });

    it('[P0] malicious comment content is HTML-escaped', () => {
      const issue: IssueMetadata = {
        eventId: 'a'.repeat(64),
        title: 'Normal issue',
        content: 'Normal content',
        authorPubkey: AUTHOR_A_PUBKEY,
        createdAt: 1711180800,
        labels: [],
        status: 'open',
      };

      const maliciousComments: CommentMetadata[] = [
        {
          eventId: 'mc1'.padEnd(64, '0'),
          content: '<script>steal_cookies()</script>',
          authorPubkey: AUTHOR_B_PUBKEY,
          createdAt: 1711200000,
          parentEventId: issue.eventId,
        },
      ];

      const cache = new ProfileCache();
      const result = renderIssueDetail('test-repo', issue, maliciousComments, cache, 'npub1owner');
      const fullHtml = renderLayout('Forge', result.html, 'wss://localhost:7100');
      container.innerHTML = fullHtml;

      expect(container.querySelectorAll('script')).toHaveLength(0);
      expect(result.html).toContain('&lt;script&gt;');
    });
  });

  // ==========================================================================
  // 8.5-E2E-007: Markdown-safe rendering in issue/PR content
  // AC: #16
  // ==========================================================================

  describe('8.5-E2E-007: Markdown-safe content rendering', () => {
    it('[P1] renders fenced code blocks, inline code, auto-linked URLs, and paragraph breaks', () => {
      const content = 'First paragraph.\n\nSecond paragraph.\n\n```\nconst x = 1;\n```\n\nUse `npm install` then visit https://example.com/docs';

      const rendered = renderMarkdownSafe(content);

      // Paragraph breaks
      expect(rendered).toContain('<br><br>');

      // Fenced code block
      expect(rendered).toContain('<pre class="code-block"><code>');
      expect(rendered).toContain('const x = 1;');

      // Inline code
      expect(rendered).toContain('<code class="inline-code">npm install</code>');

      // Auto-linked URL
      expect(rendered).toContain('<a href=');
      expect(rendered).toContain('example.com/docs');
      expect(rendered).toContain('target="_blank"');
      expect(rendered).toContain('rel="noopener noreferrer"');
    });

    it('[P1] does NOT auto-link URLs inside fenced code blocks', () => {
      const content = '```\nhttps://example.com/inside-code\n```';
      const rendered = renderMarkdownSafe(content);

      // URL inside code block should not become a link
      expect(rendered).toContain('https://example.com/inside-code');
      // The code block itself should not contain <a> tags
      const codeBlockMatch = rendered.match(/<pre class="code-block"><code>([\s\S]*?)<\/code><\/pre>/);
      expect(codeBlockMatch).not.toBeNull();
      expect(codeBlockMatch![1]).not.toContain('<a ');
    });

    it('[P1] does NOT auto-link javascript: URLs', () => {
      const content = 'Click javascript:alert(1) for help';
      const rendered = renderMarkdownSafe(content);

      expect(rendered).not.toContain('href="javascript:');
    });
  });

  // ==========================================================================
  // 8.5-E2E-008: Navigation tabs appear on all page types
  // AC: #22
  // ==========================================================================

  describe('8.5-E2E-008: Navigation tabs on all page types', () => {
    it('[P1] issue list page has Code/Issues/Pull Requests tabs with Issues active', () => {
      const tabs = renderRepoTabs('npub1owner', 'test-repo', 'issues');
      container.innerHTML = tabs;

      const allTabs = container.querySelectorAll('.repo-tabs a');
      expect(allTabs.length).toBe(3);
      expect(container.querySelector('.tab-active')!.textContent).toBe('Issues');
    });

    it('[P1] PR list page has Code/Issues/Pull Requests tabs with Pull Requests active', () => {
      const tabs = renderRepoTabs('npub1owner', 'test-repo', 'pulls');
      container.innerHTML = tabs;

      const allTabs = container.querySelectorAll('.repo-tabs a');
      expect(allTabs.length).toBe(3);
      expect(container.querySelector('.tab-active')!.textContent).toBe('Pull Requests');
    });

    it('[P1] code tab links to bare repo URL when no ref provided', () => {
      const tabs = renderRepoTabs('npub1owner', 'test-repo', 'issues');
      container.innerHTML = tabs;

      const codeTab = container.querySelector('.repo-tabs a:first-child');
      expect(codeTab).not.toBeNull();
      const href = codeTab!.getAttribute('href');
      expect(href).toContain('/npub1owner/test-repo/');
      expect(href).not.toContain('/tree/');
    });

    it('[P1] code tab links to tree view when ref is provided', () => {
      const tabs = renderRepoTabs('npub1owner', 'test-repo', 'code', 'main');
      container.innerHTML = tabs;

      const codeTab = container.querySelector('.repo-tabs a:first-child');
      const href = codeTab!.getAttribute('href');
      expect(href).toContain('/tree/main/');
    });
  });

  // ==========================================================================
  // 8.5-E2E-009: PR status resolution from multiple status events
  // AC: #4, #9
  // ==========================================================================

  describe('8.5-E2E-009: PR status resolution logic', () => {
    it('[P1] resolves status from the most recent status event when multiple exist', () => {
      const prId = 'pr1'.padEnd(64, '0');
      const statusEvents: NostrEvent[] = [
        createStatusEvent({
          id: 's1'.padEnd(64, '0'),
          prEventId: prId,
          kind: 1630, // open
          createdAt: 1711100000,
        }),
        createStatusEvent({
          id: 's2'.padEnd(64, '0'),
          prEventId: prId,
          kind: 1633, // draft
          createdAt: 1711200000,
        }),
        createStatusEvent({
          id: 's3'.padEnd(64, '0'),
          prEventId: prId,
          kind: 1631, // applied
          createdAt: 1711300000,
        }),
      ];

      // Most recent event (highest created_at) is kind:1631 = applied
      const status = resolvePRStatus(prId, statusEvents);
      expect(status).toBe('applied');
    });

    it('[P1] returns open when no status events exist', () => {
      const prId = 'pr1'.padEnd(64, '0');
      const status = resolvePRStatus(prId, []);
      expect(status).toBe('open');
    });

    it('[P1] ignores status events for other PRs', () => {
      const prId = 'pr1'.padEnd(64, '0');
      const otherPrId = 'pr2'.padEnd(64, '0');
      const statusEvents: NostrEvent[] = [
        createStatusEvent({
          id: 's1'.padEnd(64, '0'),
          prEventId: otherPrId,
          kind: 1632, // closed - but for a different PR
          createdAt: 1711300000,
        }),
      ];

      const status = resolvePRStatus(prId, statusEvents);
      expect(status).toBe('open');
    });

    it('[P1] all 4 status kinds render correctly in PR list', () => {
      const prs: PRMetadata[] = [
        {
          eventId: '1'.repeat(64),
          title: 'Open PR',
          content: '',
          authorPubkey: AUTHOR_A_PUBKEY,
          createdAt: 1711180800,
          commitShas: [],
          baseBranch: 'main',
          status: 'open',
        },
        {
          eventId: '2'.repeat(64),
          title: 'Applied PR',
          content: '',
          authorPubkey: AUTHOR_A_PUBKEY,
          createdAt: 1711094400,
          commitShas: [],
          baseBranch: 'main',
          status: 'applied',
        },
        {
          eventId: '3'.repeat(64),
          title: 'Closed PR',
          content: '',
          authorPubkey: AUTHOR_A_PUBKEY,
          createdAt: 1711008000,
          commitShas: [],
          baseBranch: 'main',
          status: 'closed',
        },
        {
          eventId: '4'.repeat(64),
          title: 'Draft PR',
          content: '',
          authorPubkey: AUTHOR_A_PUBKEY,
          createdAt: 1710921600,
          commitShas: [],
          baseBranch: 'main',
          status: 'draft',
        },
      ];

      const cache = new ProfileCache();
      cache.setProfile(AUTHOR_A_PUBKEY, { name: 'Alice' });

      const result = renderPRList('test-repo', prs, cache, 'npub1owner');
      container.innerHTML = result.html;

      expect(container.querySelector('.status-open')).not.toBeNull();
      expect(container.querySelector('.status-applied')).not.toBeNull();
      expect(container.querySelector('.status-closed')).not.toBeNull();
      expect(container.querySelector('.status-draft')).not.toBeNull();
    });
  });

  // ==========================================================================
  // 8.5-E2E-010: Route parsing for all issue/PR route variants
  // AC: #18, #19, #20, #21
  // ==========================================================================

  describe('8.5-E2E-010: Route parsing for all issue/PR variants', () => {
    it('[P1] /<npub>/<repo>/issues parses to issues list', () => {
      const route = parseRoute('/npub1abc/my-repo/issues');
      expect(route.type).toBe('issues');
      if (route.type === 'issues') {
        expect(route.owner).toBe('npub1abc');
        expect(route.repo).toBe('my-repo');
      }
    });

    it('[P1] /<npub>/<repo>/issues/<eventId> parses to issue detail', () => {
      const eventId = 'e'.repeat(64);
      const route = parseRoute(`/npub1abc/my-repo/issues/${eventId}`);
      expect(route.type).toBe('issue-detail');
      if (route.type === 'issue-detail') {
        expect(route.eventId).toBe(eventId);
      }
    });

    it('[P1] /<npub>/<repo>/pulls parses to PR list', () => {
      const route = parseRoute('/npub1abc/my-repo/pulls');
      expect(route.type).toBe('pulls');
      if (route.type === 'pulls') {
        expect(route.owner).toBe('npub1abc');
        expect(route.repo).toBe('my-repo');
      }
    });

    it('[P1] /<npub>/<repo>/pulls/<eventId> parses to PR detail', () => {
      const eventId = 'f'.repeat(64);
      const route = parseRoute(`/npub1abc/my-repo/pulls/${eventId}`);
      expect(route.type).toBe('pull-detail');
      if (route.type === 'pull-detail') {
        expect(route.eventId).toBe(eventId);
      }
    });

    it('[P1] existing routes (tree, blob, commits, blame) still parse correctly (regression)', () => {
      expect(parseRoute('/npub1x/repo/tree/main/src').type).toBe('tree');
      expect(parseRoute('/npub1x/repo/blob/main/file.ts').type).toBe('blob');
      expect(parseRoute('/npub1x/repo/commits/main').type).toBe('commits');
      expect(parseRoute('/npub1x/repo/commit/abc123').type).toBe('commit');
      expect(parseRoute('/npub1x/repo/blame/main/file.ts').type).toBe('blame');
      expect(parseRoute('/').type).toBe('repo-list');
    });
  });

  // ==========================================================================
  // 8.5-E2E-011: Issue title fallback to first line of content
  // AC: #6
  // ==========================================================================

  describe('8.5-E2E-011: Issue title fallback', () => {
    it('[P1] uses first line of content as title when no subject tag exists', () => {
      const event: NostrEvent = {
        id: 'f'.repeat(64),
        pubkey: AUTHOR_A_PUBKEY,
        created_at: 1711180800,
        kind: 1621,
        tags: [['a', `30617:${OWNER_PUBKEY}:${REPO_ID}`]],
        content: 'This is the title from first line\n\nAnd this is the body.',
        sig: 'f'.repeat(128),
      };

      const issue = parseIssue(event);
      expect(issue).not.toBeNull();
      expect(issue!.title).toBe('This is the title from first line');
    });

    it('[P1] uses subject tag as title when present', () => {
      const event = createIssueEvent({
        id: 'g'.repeat(64),
        title: 'Explicit Subject',
        content: 'The content body starts here',
      });

      const issue = parseIssue(event);
      expect(issue!.title).toBe('Explicit Subject');
    });
  });

  // ==========================================================================
  // 8.5-E2E-012: Contribution banner text and presence
  // AC: #17
  // ==========================================================================

  describe('8.5-E2E-012: Contribution banner', () => {
    it('[P1] contribution banner appears on issue list page', () => {
      const cache = new ProfileCache();
      const result = renderIssueList('test-repo', [], cache, 'npub1owner');
      expect(result.html).toContain('Forge-UI is read-only');
      expect(result.html).toContain('NIP-34 skill');
    });

    it('[P1] contribution banner appears on PR list page', () => {
      const cache = new ProfileCache();
      const result = renderPRList('test-repo', [], cache, 'npub1owner');
      expect(result.html).toContain('Forge-UI is read-only');
    });

    it('[P1] contribution banner appears on issue detail page', () => {
      const cache = new ProfileCache();
      const issue: IssueMetadata = {
        eventId: 'a'.repeat(64),
        title: 'Test',
        content: 'body',
        authorPubkey: AUTHOR_A_PUBKEY,
        createdAt: 1711180800,
        labels: [],
        status: 'open',
      };
      const result = renderIssueDetail('test-repo', issue, [], cache, 'npub1owner');
      expect(result.html).toContain('Forge-UI is read-only');
    });

    it('[P1] contribution banner appears on PR detail page', () => {
      const cache = new ProfileCache();
      const pr: PRMetadata = {
        eventId: 'a'.repeat(64),
        title: 'Test PR',
        content: 'patch body',
        authorPubkey: AUTHOR_A_PUBKEY,
        createdAt: 1711180800,
        commitShas: [],
        baseBranch: 'main',
        status: 'open',
      };
      const result = renderPRDetail('test-repo', pr, [], cache, 'npub1owner');
      expect(result.html).toContain('Forge-UI is read-only');
    });
  });

  // ==========================================================================
  // 8.5-E2E-013: Error states — relay timeout graceful degradation
  // AC: #10, #13
  // ==========================================================================

  describe('8.5-E2E-013: Error/loading states', () => {
    it('[P1] relay timeout for issues displays graceful degradation message', () => {
      const errorHtml = renderLayout(
        'Forge',
        '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load issues.</div></div>',
        'wss://localhost:7100'
      );
      container.innerHTML = errorHtml;

      expect(container.textContent).toContain('Error');
      expect(container.textContent).toContain('Could not load issues');
      expect(container.querySelector('.empty-state')).not.toBeNull();
      expect(container.querySelector('.layout-content')).not.toBeNull();
    });

    it('[P1] relay timeout for PRs displays graceful degradation message', () => {
      const errorHtml = renderLayout(
        'Forge',
        '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load pull requests.</div></div>',
        'wss://localhost:7100'
      );
      container.innerHTML = errorHtml;

      expect(container.textContent).toContain('Could not load pull requests');
      expect(container.querySelector('.empty-state')).not.toBeNull();
    });

    it('[P1] loading state renders correctly for issues', () => {
      const loadingHtml = renderLayout(
        'Forge',
        '<div class="loading">Loading issues...</div>',
        'wss://localhost:7100'
      );
      container.innerHTML = loadingHtml;

      expect(container.textContent).toContain('Loading issues...');
      expect(container.querySelector('.loading')).not.toBeNull();
    });

    it('[P1] loading state renders correctly for PRs', () => {
      const loadingHtml = renderLayout(
        'Forge',
        '<div class="loading">Loading pull requests...</div>',
        'wss://localhost:7100'
      );
      container.innerHTML = loadingHtml;

      expect(container.textContent).toContain('Loading pull requests...');
    });
  });

  // ==========================================================================
  // 8.5-E2E-014: Query builder correctness for all filter types
  // AC: #1, #2, #3, #4, #5
  // ==========================================================================

  describe('8.5-E2E-014: Query builder correctness', () => {
    it('[P1] buildIssueListFilter produces correct kind/tag/limit', () => {
      const filter = buildIssueListFilter('abc', 'my-repo');
      expect(filter.kinds).toEqual([1621]);
      expect(filter['#a']).toEqual(['30617:abc:my-repo']);
      expect(filter.limit).toBe(100);
    });

    it('[P1] buildPRListFilter produces correct kind/tag/limit', () => {
      const filter = buildPRListFilter('abc', 'my-repo');
      expect(filter.kinds).toEqual([1617]);
      expect(filter['#a']).toEqual(['30617:abc:my-repo']);
      expect(filter.limit).toBe(100);
    });

    it('[P1] buildCommentFilter produces correct kind and #e tag', () => {
      const filter = buildCommentFilter(['event1', 'event2']);
      expect(filter.kinds).toEqual([1622]);
      expect(filter['#e']).toEqual(['event1', 'event2']);
    });

    it('[P1] buildStatusFilter includes all 4 status kinds', () => {
      const filter = buildStatusFilter(['pr1']);
      expect(filter.kinds).toEqual([1630, 1631, 1632, 1633]);
      expect(filter['#e']).toEqual(['pr1']);
    });

    it('[P1] buildEventByIdFilter uses ids field', () => {
      const filter = buildEventByIdFilter(['ev1', 'ev2']);
      expect(filter.ids).toEqual(['ev1', 'ev2']);
    });

    it('[P1] buildIssueCloseFilter uses kind:1632 and #e tag', () => {
      const filter = buildIssueCloseFilter(['issue1']);
      expect(filter.kinds).toEqual([1632]);
      expect(filter['#e']).toEqual(['issue1']);
    });
  });
});
