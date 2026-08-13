import { describe, it, expect } from 'vitest';
import { normalizeNotice, trustedNoticeFrom } from './notice.js';

describe('normalizeNotice', () => {
  it('normalizes a well-formed notice', () => {
    expect(
      normalizeNotice({
        id: 'n1',
        severity: 'action-required',
        summary: 'Read this',
        url: 'https://example.test/n1',
      })
    ).toEqual({
      id: 'n1',
      severity: 'action-required',
      summary: 'Read this',
      url: 'https://example.test/n1',
    });
  });

  it('degrades an unrecognized severity to info rather than rejecting', () => {
    expect(
      normalizeNotice({
        id: 'n1',
        severity: 'critical', // a future value this build doesn't know
        summary: 'Read this',
        url: 'https://example.test/n1',
      })
    ).toMatchObject({ severity: 'info' });
  });

  it('defaults a missing severity to info', () => {
    expect(
      normalizeNotice({
        id: 'n1',
        summary: 'Read this',
        url: 'https://example.test/n1',
      })
    ).toMatchObject({ severity: 'info' });
  });

  it('ignores unknown keys', () => {
    expect(
      normalizeNotice({
        id: 'n1',
        severity: 'info',
        summary: 'Read this',
        url: 'https://example.test/n1',
        extra: 'ignored',
      })
    ).toEqual({
      id: 'n1',
      severity: 'info',
      summary: 'Read this',
      url: 'https://example.test/n1',
    });
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['missing id', { severity: 'info', summary: 's', url: 'u' }],
    ['empty id', { id: '', summary: 's', url: 'u' }],
    ['missing summary', { id: 'n1', url: 'u' }],
    ['missing url', { id: 'n1', summary: 's' }],
    ['non-string id', { id: 5, summary: 's', url: 'u' }],
  ])('drops a malformed notice: %s', (_label, value) => {
    expect(normalizeNotice(value)).toBeUndefined();
  });
});

describe('trustedNoticeFrom', () => {
  const rawNotice = {
    id: 'n1',
    severity: 'info',
    summary: 'Read this',
    url: 'https://example.test/n1',
  };

  it('surfaces the notice when the announcer pubkey is trusted', () => {
    expect(
      trustedNoticeFrom('seed-pubkey', rawNotice, ['seed-pubkey'])
    ).toEqual({
      id: 'n1',
      severity: 'info',
      summary: 'Read this',
      url: 'https://example.test/n1',
    });
  });

  it('drops the notice when the announcer pubkey is untrusted', () => {
    expect(
      trustedNoticeFrom('rando', rawNotice, ['seed-pubkey'])
    ).toBeUndefined();
  });

  it('drops the notice when there are no trusted pubkeys configured', () => {
    expect(trustedNoticeFrom('seed-pubkey', rawNotice, [])).toBeUndefined();
  });

  it('is malformed-safe even from a trusted announcer', () => {
    expect(
      trustedNoticeFrom('seed-pubkey', { id: '' }, ['seed-pubkey'])
    ).toBeUndefined();
  });
});
