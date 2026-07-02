// Test IDs: 8.6-E2E-004, 8.6-E2E-005
// AC covered: #12 (Issues list), #13 (Issue detail)

import { test, expect } from '@playwright/test';

const RELAY_URL = 'ws://localhost:19700';

test.describe('Issues List (8.6-E2E-004)', () => {
  test('renders issues with titles, status badges, and timestamps', async ({
    page,
  }) => {
    // Navigate to repo list and click into a repo
    await page.goto(`/?relay=${encodeURIComponent(RELAY_URL)}`);
    const repoCard = page.locator('.repo-card').first();
    await expect(repoCard).toBeVisible({ timeout: 15000 });
    await repoCard.locator('.repo-name').click();

    // Wait for tree view, then click Issues tab
    const treeContainer = page.locator('.tree-view, .file-tree');
    await expect(treeContainer).toBeVisible({ timeout: 15000 });

    const issuesTab = page.locator('a[href*="/issues"]').first();
    await expect(issuesTab).toBeVisible();
    await issuesTab.click();

    // Wait for issues list to render
    const issueItem = page.locator(
      '.issue-item, .issue-card, .issue-row'
    ).first();
    await expect(issueItem).toBeVisible({ timeout: 15000 });

    // Verify at least one issue is listed
    const issueCount = await page
      .locator('.issue-item, .issue-card, .issue-row')
      .count();
    expect(issueCount).toBeGreaterThanOrEqual(1);

    // Verify issue has a title
    const issueTitle = issueItem.locator(
      '.issue-title-link, .issue-title, a[href*="/issues/"]'
    );
    await expect(issueTitle).toBeVisible();
    const titleText = await issueTitle.textContent();
    expect(titleText!.length).toBeGreaterThan(0);

    // Verify status badge is visible
    const statusBadge = page.locator(
      '.issue-status, .status-badge, [class*="badge"]'
    ).first();
    await expect(statusBadge).toBeVisible();

    // Verify timestamp is visible
    const timestamp = page.locator(
      '.issue-date, .issue-time, time, [class*="date"], [class*="time"]'
    ).first();
    await expect(timestamp).toBeVisible();

    // Verify labels are displayed (AC #12: issues appear with labels)
    // At least one issue should have label badges from seed data
    const labelBadges = page.locator('.label-badge');
    const labelCount = await labelBadges.count();
    expect(labelCount).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Issue Detail (8.6-E2E-005)', () => {
  test('renders issue title, body, and status badge', async ({ page }) => {
    // Navigate to repo list -> repo -> issues
    await page.goto(`/?relay=${encodeURIComponent(RELAY_URL)}`);
    const repoCard = page.locator('.repo-card').first();
    await expect(repoCard).toBeVisible({ timeout: 15000 });
    await repoCard.locator('.repo-name').click();

    const treeContainer = page.locator('.tree-view, .file-tree');
    await expect(treeContainer).toBeVisible({ timeout: 15000 });

    const issuesTab = page.locator('a[href*="/issues"]').first();
    await issuesTab.click();

    // Wait for issues list and click the first issue
    const issueLink = page.locator(
      '.issue-title-link, .issue-item a, .issue-card a, a[href*="/issues/"]'
    ).first();
    await expect(issueLink).toBeVisible({ timeout: 15000 });
    await issueLink.click();

    // Wait for issue detail to render
    const issueDetail = page.locator(
      '.issue-detail, .issue-content, .issue-body'
    );
    await expect(issueDetail.first()).toBeVisible({ timeout: 15000 });

    // Verify issue title is displayed
    const title = page.locator(
      '.issue-detail-title, .issue-title, h1, h2'
    ).first();
    await expect(title).toBeVisible();
    const titleText = await title.textContent();
    expect(titleText!.length).toBeGreaterThan(0);

    // Verify issue body content is visible
    const body = page.locator(
      '.issue-detail-body, .issue-body, .issue-content, .markdown-body'
    ).first();
    await expect(body).toBeVisible();

    // Verify status badge is visible and reflects open/closed state (AC #13)
    const statusBadge = page.locator(
      '.issue-detail-meta .status-badge, .issue-status, .status-badge'
    ).first();
    await expect(statusBadge).toBeVisible();
    const badgeText = await statusBadge.textContent();
    expect(['open', 'closed']).toContain(badgeText!.trim().toLowerCase());

    // AC #13: Verify comments render (comment thread section exists)
    const commentThread = page.locator('.comment-thread');
    await expect(commentThread).toBeVisible({ timeout: 10000 });

    // Verify at least one comment is rendered (seed data includes comments)
    const comments = page.locator('.comment');
    const commentCount = await comments.count();
    expect(commentCount).toBeGreaterThanOrEqual(1);

    // Verify comment has author and body
    const firstComment = comments.first();
    const commentAuthor = firstComment.locator('.comment-author');
    await expect(commentAuthor).toBeVisible();
    const commentBody = firstComment.locator('.comment-body');
    await expect(commentBody).toBeVisible();
  });
});
