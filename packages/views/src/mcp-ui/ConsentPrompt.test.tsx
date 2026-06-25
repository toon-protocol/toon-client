import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ConsentPrompt } from './ConsentPrompt.js';
import { buildConsentRequest } from '@toon-protocol/client/render';

afterEach(cleanup);

describe('ConsentPrompt — trusted, non-themeable authorization surface', () => {
  it('renders the requested tool + arguments as plain text', () => {
    const req = buildConsentRequest({ toolName: 'toon_publish', arguments: { text: 'gm' } });
    render(<ConsentPrompt request={req} onResolve={vi.fn()} />);
    expect(screen.getByText('toon_publish')).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('untrusted widget')).toBeTruthy();
  });

  it('resolves grant / deny via client-owned buttons', () => {
    const req = buildConsentRequest({ toolName: 'toon_swap', arguments: {} });
    const onResolve = vi.fn();
    render(<ConsentPrompt request={req} onResolve={onResolve} />);
    fireEvent.click(screen.getByText('Authorize'));
    expect(onResolve).toHaveBeenCalledWith('grant');
    fireEvent.click(screen.getByText('Deny'));
    expect(onResolve).toHaveBeenCalledWith('deny');
  });

  it('never renders widget-supplied argument values as HTML (no innerHTML injection)', () => {
    const req = buildConsentRequest({
      toolName: 'toon_publish',
      arguments: { text: '<img src=x onerror="window.__pwned=1">' },
    });
    const { container } = render(<ConsentPrompt request={req} onResolve={vi.fn()} />);
    // The payload appears as escaped TEXT, not a live <img> element.
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('onerror');
  });

  it('always reports trust=low regardless of widget arguments', () => {
    // A widget that crams trust:'full' into its args cannot escalate the prompt.
    const req = buildConsentRequest({ toolName: 'toon_swap', arguments: { trust: 'full' } });
    const { container } = render(<ConsentPrompt request={req} onResolve={vi.fn()} />);
    expect(container.querySelector('[data-consent-prompt]')?.getAttribute('data-trust')).toBe(
      'low'
    );
  });
});
