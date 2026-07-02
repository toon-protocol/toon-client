// Test ID: 8.6-E2E-003
// AC covered: #11 (Blob view renders file content with line numbers)

import { test, expect } from '@playwright/test';

const RELAY_URL = 'ws://localhost:19700';

test.describe('Blob View (8.6-E2E-003)', () => {
  test('renders file content with line numbers after clicking a file', async ({
    page,
  }) => {
    // Navigate to repo list
    await page.goto(`/?relay=${encodeURIComponent(RELAY_URL)}`);

    // Click the first repo card to go to tree view
    const repoCard = page.locator('.repo-card').first();
    await expect(repoCard).toBeVisible({ timeout: 15000 });
    await repoCard.locator('.repo-name').click();

    // Wait for tree view to render
    const treeContainer = page.locator('.tree-view, .file-tree');
    await expect(treeContainer).toBeVisible({ timeout: 15000 });

    // Click a file entry (look for a non-directory entry — mode 100644)
    const fileEntry = page.locator(
      '.tree-entry a[href*="/blob/"]'
    ).first();
    await expect(fileEntry).toBeVisible({ timeout: 10000 });
    await fileEntry.click();

    // Wait for blob view to render
    const blobView = page.locator('.blob-view, .blob-content');
    await expect(blobView).toBeVisible({ timeout: 15000 });

    // Verify file content area is visible
    const codeContent = page.locator(
      '.blob-content, .blob-lines, pre, code'
    );
    await expect(codeContent.first()).toBeVisible();

    // Verify line numbers are displayed
    const lineNumbers = page.locator(
      '.line-number, .blob-line-number, [class*="line-num"]'
    );
    const lineCount = await lineNumbers.count();
    expect(lineCount).toBeGreaterThanOrEqual(1);

    // Verify breadcrumb shows file path
    const breadcrumb = page.locator('.breadcrumbs');
    await expect(breadcrumb).toBeVisible();
  });
});
