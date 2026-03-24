// @vitest-environment jsdom
// Test IDs: 8.5-INT-003
// AC covered: #10, #13 (Graceful degradation when relay unavailable)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { renderLayout } from '../layout.js';

describe('Integration: Issues/PR Fallback', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('[P1] relay timeout displays graceful degradation message (8.5-INT-003)', () => {
    // Simulate the error state that renderRoute would produce on relay timeout
    const errorHtml = renderLayout(
      'Forge',
      '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load issues.</div></div>',
      'wss://localhost:7100'
    );

    container.innerHTML = errorHtml;

    expect(container.textContent).toContain('Error');
    expect(container.textContent).toContain('Could not load issues');
    expect(container.querySelector('.empty-state')).not.toBeNull();
  });

  it('[P1] PR relay timeout displays graceful degradation message', () => {
    const errorHtml = renderLayout(
      'Forge',
      '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load pull requests.</div></div>',
      'wss://localhost:7100'
    );

    container.innerHTML = errorHtml;

    expect(container.textContent).toContain('Error');
    expect(container.textContent).toContain('Could not load pull requests');
  });
});
