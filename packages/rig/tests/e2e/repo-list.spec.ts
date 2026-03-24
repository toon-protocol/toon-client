// Test ID: 8.6-E2E-001
// AC covered: #9 (Repository list renders with repo cards)

import { test, expect } from '@playwright/test';

const RELAY_URL = 'ws://localhost:19700';

test.describe('Repository List (8.6-E2E-001)', () => {
  test('renders at least one repo card with expected content', async ({
    page,
  }) => {
    await page.goto(`/?relay=${encodeURIComponent(RELAY_URL)}`);

    // Wait for repo cards to render (relay query + render cycle)
    const repoCard = page.locator('.repo-card').first();
    await expect(repoCard).toBeVisible({ timeout: 15000 });

    // Verify at least one repo card exists
    const cardCount = await page.locator('.repo-card').count();
    expect(cardCount).toBeGreaterThanOrEqual(1);

    // Verify card contains expected content
    const cardText = await repoCard.textContent();
    expect(cardText).toBeTruthy();

    // Verify repo name is visible
    const repoName = repoCard.locator('.repo-name');
    await expect(repoName).toBeVisible();
    const nameText = await repoName.textContent();
    expect(nameText).toContain('TOON Protocol');

    // Verify description is visible
    const repoDescription = repoCard.locator('.repo-description');
    await expect(repoDescription).toBeVisible();
    const descText = await repoDescription.textContent();
    expect(descText!.length).toBeGreaterThan(0);

    // Verify owner display (npub or display name)
    const repoOwner = repoCard.locator('.repo-owner');
    await expect(repoOwner).toBeVisible();
    const ownerText = await repoOwner.textContent();
    expect(ownerText!.length).toBeGreaterThan(0);

    // Verify default branch badge
    const branchBadge = repoCard.locator('.repo-branch-badge');
    await expect(branchBadge).toBeVisible();
  });
});
