import { describe, it, expect } from 'vitest';
import {
  BRANCH3_SANDBOX_PERMISSIONS,
  BRANCH3_SANDBOX_TOKENS,
  FORBIDDEN_SANDBOX_TOKENS,
  assertSafeSandbox,
} from './sandbox.js';

describe('branch-3 sandbox hardening', () => {
  it('grants only allow-scripts', () => {
    expect(BRANCH3_SANDBOX_TOKENS).toEqual(['allow-scripts']);
  });

  it('does NOT grant allow-same-origin (the key isolation property)', () => {
    expect(BRANCH3_SANDBOX_TOKENS).not.toContain('allow-same-origin');
    expect(BRANCH3_SANDBOX_PERMISSIONS).not.toContain('allow-same-origin');
  });

  it('withholds every escape token', () => {
    for (const forbidden of FORBIDDEN_SANDBOX_TOKENS) {
      expect(BRANCH3_SANDBOX_TOKENS).not.toContain(forbidden);
    }
  });

  it('assertSafeSandbox accepts the hardened permission string', () => {
    expect(() => assertSafeSandbox(BRANCH3_SANDBOX_PERMISSIONS)).not.toThrow();
  });

  it('assertSafeSandbox rejects allow-same-origin', () => {
    expect(() => assertSafeSandbox('allow-scripts allow-same-origin')).toThrow(
      /allow-same-origin/
    );
  });

  it('assertSafeSandbox rejects top-navigation / popups / modals / forms', () => {
    expect(() => assertSafeSandbox('allow-scripts allow-top-navigation')).toThrow();
    expect(() => assertSafeSandbox('allow-scripts allow-popups')).toThrow();
    expect(() => assertSafeSandbox('allow-scripts allow-modals')).toThrow();
    expect(() => assertSafeSandbox('allow-scripts allow-forms')).toThrow();
  });
});
