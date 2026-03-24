// Test ID: 8.6-E2E-002
// AC covered: #10 (Tree view renders file tree with directories and files)

import { test, expect } from '@playwright/test';

const RELAY_URL = 'ws://localhost:19700';

test.describe('Tree View (8.6-E2E-002)', () => {
  test('renders file tree after clicking repo card', async ({ page }) => {
    // Navigate to repo list
    await page.goto(`/?relay=${encodeURIComponent(RELAY_URL)}`);

    // Wait for and click the first repo card
    const repoCard = page.locator('.repo-card').first();
    await expect(repoCard).toBeVisible({ timeout: 15000 });
    await repoCard.locator('.repo-name').click();

    // Wait for tree view to render
    const treeContainer = page.locator('.tree-view, .file-tree');
    await expect(treeContainer).toBeVisible({ timeout: 15000 });

    // Verify at least one tree entry exists
    const treeEntries = page.locator('.tree-entry');
    const entryCount = await treeEntries.count();
    expect(entryCount).toBeGreaterThanOrEqual(1);

    // AC #10: Verify directory entries (mode 40000) exist
    const dirEntries = page.locator('.tree-entry .tree-entry-mode');
    const allModes: string[] = [];
    const modeCount = await dirEntries.count();
    for (let i = 0; i < modeCount; i++) {
      const modeText = await dirEntries.nth(i).textContent();
      if (modeText) allModes.push(modeText.trim());
    }
    const hasDirectory = allModes.some((m) => m === '40000');
    const hasFile = allModes.some((m) => m === '100644');
    expect(hasDirectory).toBe(true);
    expect(hasFile).toBe(true);

    // Verify breadcrumb shows repo name and ref
    const breadcrumb = page.locator('.breadcrumbs');
    await expect(breadcrumb).toBeVisible();
    const breadcrumbText = await breadcrumb.textContent();
    expect(breadcrumbText!.length).toBeGreaterThan(0);

    // Verify Commits link is present
    const commitsLink = page.locator(
      'a[href*="/commits/"], .breadcrumb-commits-link'
    );
    await expect(commitsLink).toBeVisible();
  });
});
