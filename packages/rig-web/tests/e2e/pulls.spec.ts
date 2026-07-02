// Test ID: 8.6-E2E-006
// AC covered: #14 (PR list with status badges, titles, timestamps)

import { test, expect } from '@playwright/test';

const RELAY_URL = 'ws://localhost:19700';

test.describe('PR List (8.6-E2E-006)', () => {
  test('renders pull requests with titles, status badges, and timestamps', async ({
    page,
  }) => {
    // Navigate to repo list and click into a repo
    await page.goto(`/?relay=${encodeURIComponent(RELAY_URL)}`);
    const repoCard = page.locator('.repo-card').first();
    await expect(repoCard).toBeVisible({ timeout: 15000 });
    await repoCard.locator('.repo-name').click();

    // Wait for tree view, then click Pull Requests tab
    const treeContainer = page.locator('.tree-view, .file-tree');
    await expect(treeContainer).toBeVisible({ timeout: 15000 });

    const pullsTab = page.locator('a[href*="/pulls"]').first();
    await expect(pullsTab).toBeVisible();
    await pullsTab.click();

    // Wait for PR list to render
    const prItem = page.locator('.pr-item, .pr-card, .pr-row').first();
    await expect(prItem).toBeVisible({ timeout: 15000 });

    // Verify at least one PR is listed
    const prCount = await page
      .locator('.pr-item, .pr-card, .pr-row')
      .count();
    expect(prCount).toBeGreaterThanOrEqual(1);

    // Verify PR has a title
    const prTitle = prItem.locator('.pr-title-link, .pr-title, a[href*="/pulls/"]');
    await expect(prTitle).toBeVisible();
    const titleText = await prTitle.textContent();
    expect(titleText!.length).toBeGreaterThan(0);

    // Verify status badge is visible and shows valid PR status (AC #14: Applied/Open)
    const statusBadge = page.locator(
      '.pr-row .status-badge, .pr-status, .status-badge'
    ).first();
    await expect(statusBadge).toBeVisible();
    const badgeText = await statusBadge.textContent();
    expect(['open', 'closed', 'applied', 'draft']).toContain(
      badgeText!.trim().toLowerCase()
    );

    // Verify timestamp is visible
    const timestamp = page.locator(
      '.pr-date, .pr-time, time, [class*="date"], [class*="time"]'
    ).first();
    await expect(timestamp).toBeVisible();
  });
});
