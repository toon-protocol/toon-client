// Test ID: 8.6-E2E-007
// AC covered: #15 (Navigation flow: repo list -> tree -> issues -> issue -> back -> pulls)

import { test, expect } from '@playwright/test';

const RELAY_URL = 'ws://localhost:19700';

test.describe('Navigation Flow (8.6-E2E-007)', () => {
  test('full navigation flow renders each view without errors', async ({
    page,
  }) => {
    // Collect JS errors during the test
    const jsErrors: string[] = [];
    page.on('pageerror', (error) => jsErrors.push(error.message));

    // 1. Repo list
    await page.goto(`/?relay=${encodeURIComponent(RELAY_URL)}`);
    const repoCard = page.locator('.repo-card').first();
    await expect(repoCard).toBeVisible({ timeout: 15000 });

    // Verify no 404 or error messages (case-insensitive)
    const pageText = await page.textContent('body');
    expect(pageText!.toLowerCase()).not.toContain('not found');

    // 2. Click repo -> tree view
    await repoCard.locator('.repo-name').click();
    const treeContainer = page.locator('.tree-view, .file-tree');
    await expect(treeContainer).toBeVisible({ timeout: 15000 });

    // Verify tree rendered (no 404)
    const treePageText = await page.textContent('body');
    expect(treePageText!.toLowerCase()).not.toContain('not found');

    // 3. Click Issues tab
    const issuesTab = page.locator('a[href*="/issues"]').first();
    await expect(issuesTab).toBeVisible();
    await issuesTab.click();

    // Wait for issues to render
    const issueItem = page.locator(
      '.issue-item, .issue-card, .issue-row'
    ).first();
    await expect(issueItem).toBeVisible({ timeout: 15000 });

    // 4. Click first issue -> issue detail
    const issueLink = page.locator(
      '.issue-title-link, .issue-item a, .issue-card a, a[href*="/issues/"]'
    ).first();
    await expect(issueLink).toBeVisible();

    // Record the issues list URL before navigating to detail
    const issuesUrl = page.url();
    await issueLink.click();

    // Wait for issue detail
    const issueDetail = page.locator(
      '.issue-detail, .issue-content, .issue-body'
    );
    await expect(issueDetail.first()).toBeVisible({ timeout: 15000 });

    // Verify URL changed to issue detail (contains /issues/ + eventId)
    expect(page.url()).not.toBe(issuesUrl);

    // 5. Go back to issues (browser back)
    await page.goBack();

    // Wait for issues list to re-render
    const issueItemAfterBack = page.locator(
      '.issue-item, .issue-card, .issue-row'
    ).first();
    await expect(issueItemAfterBack).toBeVisible({ timeout: 15000 });

    // Verify browser history returned to issues list URL (AC #15: back button works)
    expect(page.url()).toContain('/issues');

    // 6. Click Pull Requests tab
    const pullsTab = page.locator('a[href*="/pulls"]').first();
    await expect(pullsTab).toBeVisible();
    await pullsTab.click();

    // Wait for PR list to render
    const prItem = page.locator('.pr-item, .pr-card, .pr-row').first();
    await expect(prItem).toBeVisible({ timeout: 15000 });

    // Verify no errors throughout the flow
    const finalText = await page.textContent('body');
    expect(finalText!.toLowerCase()).not.toContain('not found');

    // Verify no uncaught JS errors occurred during the entire navigation flow
    expect(jsErrors).toHaveLength(0);
  });
});
