import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/hooks/use-profile-cache', () => ({
  useProfileCache: () => ({
    getDisplayName: (pk: string) => `user-${pk.slice(0, 4)}`,
    requestProfiles: vi.fn(),
    version: 0,
  }),
}));
vi.mock('@/hooks/use-rig-config', () => ({
  useRigConfig: () => ({
    relayUrl: 'ws://localhost:7100',
  }),
}));

import { CommentThread } from '@/components/comment-thread';

describe('[P0] XSS Prevention', () => {
  it('escapes script tags in comment content', () => {
    const maliciousContent = '<script>alert("xss")</script>Hello world';

    const { container } = render(
      <MemoryRouter>
        <CommentThread
          originalContent={maliciousContent}
          originalAuthor={'a'.repeat(64)}
          originalCreatedAt={1700000000}
          comments={[]}
        />
      </MemoryRouter>,
    );

    // No script elements should exist
    expect(container.querySelectorAll('script').length).toBe(0);
    // The text "Hello world" should still render
    expect(container.textContent).toContain('Hello world');
  });

  it('strips javascript: URLs from markdown links', () => {
    const maliciousContent = '[click me](javascript:alert(1))';

    const { container } = render(
      <MemoryRouter>
        <CommentThread
          originalContent={maliciousContent}
          originalAuthor={'a'.repeat(64)}
          originalCreatedAt={1700000000}
          comments={[]}
        />
      </MemoryRouter>,
    );

    // No href should contain javascript:
    const links = container.querySelectorAll('a');
    for (const link of links) {
      expect(link.getAttribute('href')).not.toMatch(/^javascript:/i);
    }
  });

  it('escapes HTML entities in issue titles rendered as text', () => {
    const maliciousTitle = '<img src=x onerror=alert(1)>';

    const { container } = render(
      <MemoryRouter>
        <CommentThread
          originalContent={maliciousTitle}
          originalAuthor={'a'.repeat(64)}
          originalCreatedAt={1700000000}
          comments={[]}
        />
      </MemoryRouter>,
    );

    // No img elements should have onerror handlers
    const imgs = container.querySelectorAll('img[onerror]');
    expect(imgs.length).toBe(0);
  });
});
