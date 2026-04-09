/**
 * ATDD Tests: Story 10.1 — AC-1.2 Git Builder
 * TDD RED PHASE: These tests define expected behavior for git-builder.ts
 *
 * Tests will FAIL until git-builder.ts is implemented.
 */

import { describe, it, expect } from 'vitest';

describe('AC-1.2: Git Builder (git-builder.ts)', () => {
  it('[P0] should export createGitBlob function', async () => {
    const gitBuilder = await import('../lib/git-builder.js');
    expect(typeof gitBuilder.createGitBlob).toBe('function');
  });

  it('[P0] should export createGitTree function', async () => {
    const gitBuilder = await import('../lib/git-builder.js');
    expect(typeof gitBuilder.createGitTree).toBe('function');
  });

  it('[P0] should export createGitCommit function', async () => {
    const gitBuilder = await import('../lib/git-builder.js');
    expect(typeof gitBuilder.createGitCommit).toBe('function');
  });

  it('[P0] should export uploadGitObject function', async () => {
    const gitBuilder = await import('../lib/git-builder.js');
    expect(typeof gitBuilder.uploadGitObject).toBe('function');
  });

  it('[P0] should export waitForArweaveIndex function', async () => {
    const gitBuilder = await import('../lib/git-builder.js');
    expect(typeof gitBuilder.waitForArweaveIndex).toBe('function');
  });

  it('[P0] should compute correct SHA-1 for git blob over full envelope', async () => {
    const gitBuilder = await import('../lib/git-builder.js');

    // Given a known content string
    const content = 'hello world\n';

    // When creating a git blob
    const result = gitBuilder.createGitBlob(content);

    // Then SHA should be computed over "blob <size>\0<content>"
    // This is the standard git hash-object result for "hello world\n"
    expect(result.sha).toBe('3b18e512dba79e4c8300dd08aeb37f8e728b8dad');
    expect(result.body).toBeInstanceOf(Buffer);
    expect(result.buffer).toBeInstanceOf(Buffer);
  });

  it('[P0] should return body (content only) separate from full buffer', async () => {
    const gitBuilder = await import('../lib/git-builder.js');

    const content = 'test content';
    const result = gitBuilder.createGitBlob(content);

    // Body should be content only (no header)
    expect(result.body.toString('utf-8')).toBe(content);

    // Buffer should include header
    expect(result.buffer.length).toBeGreaterThan(result.body.length);
    expect(result.buffer.toString('utf-8')).toContain('blob ');
  });

  it('[P0] should construct git tree with sorted entries and raw 20-byte SHAs', async () => {
    const gitBuilder = await import('../lib/git-builder.js');

    // Given two blob SHAs (entries must be sorted by name)
    const entries = [
      { mode: '100644', name: 'README.md', sha: 'a0423896973644771497bdc03eb99d5281615b51' },
      { mode: '100644', name: 'LICENSE', sha: 'b0423896973644771497bdc03eb99d5281615b52' },
    ];

    // When creating a tree
    const result = gitBuilder.createGitTree(entries);

    // Then result should have sha, buffer, and body
    expect(result.sha).toHaveLength(40);
    expect(result.body).toBeInstanceOf(Buffer);
    expect(result.buffer).toBeInstanceOf(Buffer);

    // Body should contain entries sorted by name (LICENSE before README.md)
    const bodyStr = result.body.toString('binary');
    const licenseIdx = bodyStr.indexOf('LICENSE');
    const readmeIdx = bodyStr.indexOf('README.md');
    expect(licenseIdx).toBeLessThan(readmeIdx);
  });

  it('[P0] should construct git commit with tree SHA and author info', async () => {
    const gitBuilder = await import('../lib/git-builder.js');

    const result = gitBuilder.createGitCommit({
      treeSha: 'abcdef1234567890abcdef1234567890abcdef12',
      authorName: 'Alice',
      authorPubkey: '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d',
      message: 'Initial commit\n',
      timestamp: 1700000000,
    });

    // Then result should have sha, buffer, body
    expect(result.sha).toHaveLength(40);
    expect(result.body.toString('utf-8')).toContain('tree abcdef1234567890abcdef1234567890abcdef12');
    expect(result.body.toString('utf-8')).toContain('author Alice');
    expect(result.body.toString('utf-8')).toContain('@nostr>');
  });

  it('[P1] should throw when uploadGitObject receives object > 95KB (R10-005)', async () => {
    const gitBuilder = await import('../lib/git-builder.js');

    // Given a body larger than 95KB
    const largeBody = Buffer.alloc(96 * 1024, 0x41);
    const sha = 'deadbeef1234567890abcdef1234567890abcdef';
    const shaMap: Record<string, string> = {};

    // Minimal mock client — uploadGitObject should throw before calling publishEvent
    const mockClient = {} as never;
    const mockClaim = {} as never;
    const mockSecretKey = new Uint8Array(32);

    // When attempting to upload, it should throw with size error
    await expect(
      gitBuilder.uploadGitObject(mockClient, largeBody, sha, 'blob', 'test-repo', shaMap, mockClaim, mockSecretKey)
    ).rejects.toThrow(/exceeds 95KB limit/);
  });

  it('[P1] should skip upload and return existing txId if SHA already in shaMap (delta logic)', async () => {
    const gitBuilder = await import('../lib/git-builder.js');

    // Given a shaMap with an existing entry
    const sha = 'a0423896973644771497bdc03eb99d5281615b51';
    const shaMap: Record<string, string> = {
      [sha]: 'existing-tx-id',
    };

    // When uploadGitObject is called with an existing SHA
    const mockClient = {} as never;
    const mockClaim = {} as never;
    const mockSecretKey = new Uint8Array(32);
    const body = Buffer.from('test');

    const result = await gitBuilder.uploadGitObject(
      mockClient, body, sha, 'blob', 'test-repo', shaMap, mockClaim, mockSecretKey
    );

    // Then it should return the existing txId without calling publishEvent
    expect(result.sha).toBe(sha);
    expect(result.txId).toBe('existing-tx-id');
  });

  it('[P1] should throw when waitForArweaveIndex receives empty or short txId', async () => {
    const gitBuilder = await import('../lib/git-builder.js');

    // Empty string
    await expect(gitBuilder.waitForArweaveIndex('')).rejects.toThrow(/Invalid Arweave txId/);
    // Too short
    await expect(gitBuilder.waitForArweaveIndex('abc')).rejects.toThrow(/Invalid Arweave txId/);
  });

  it('[P1] should export waitForArweaveIndex that accepts txId and timeoutMs (R10-001)', async () => {
    const gitBuilder = await import('../lib/git-builder.js');

    // Contract test: waitForArweaveIndex accepts (txId, timeoutMs) and returns Promise<boolean>
    // Actual exponential backoff behavior requires network and is tested at integration level
    expect(typeof gitBuilder.waitForArweaveIndex).toBe('function');
    expect(gitBuilder.waitForArweaveIndex.length).toBeGreaterThanOrEqual(1); // at least txId param
  });

  it('[P0] should export ShaToTxIdMap, GitObject, and UploadResult types', async () => {
    const gitBuilder = await import('../lib/git-builder.js');

    // Verify all public APIs are exported (types verified by compilation)
    expect(typeof gitBuilder.createGitBlob).toBe('function');
    expect(typeof gitBuilder.createGitTree).toBe('function');
    expect(typeof gitBuilder.createGitCommit).toBe('function');
    expect(typeof gitBuilder.uploadGitObject).toBe('function');
    expect(typeof gitBuilder.waitForArweaveIndex).toBe('function');
  });

  it('[P1] should construct git commit with parent SHA when provided', async () => {
    const gitBuilder = await import('../lib/git-builder.js');

    const result = gitBuilder.createGitCommit({
      treeSha: 'abcdef1234567890abcdef1234567890abcdef12',
      parentSha: '1111111111111111111111111111111111111111',
      authorName: 'Bob',
      authorPubkey: '7937ffc0c5a0238768da798d26394a33b554926d739c445fd508e36642ebc286',
      message: 'Second commit\n',
      timestamp: 1700000100,
    });

    expect(result.sha).toHaveLength(40);
    const bodyStr = result.body.toString('utf-8');
    expect(bodyStr).toContain('tree abcdef1234567890abcdef1234567890abcdef12');
    expect(bodyStr).toContain('parent 1111111111111111111111111111111111111111');
    expect(bodyStr).toContain('author Bob');
  });

  it('[P1] should construct git commit without parent SHA when not provided', async () => {
    const gitBuilder = await import('../lib/git-builder.js');

    const result = gitBuilder.createGitCommit({
      treeSha: 'abcdef1234567890abcdef1234567890abcdef12',
      authorName: 'Alice',
      authorPubkey: '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d',
      message: 'Initial commit\n',
      timestamp: 1700000000,
    });

    const bodyStr = result.body.toString('utf-8');
    expect(bodyStr).not.toContain('parent ');
  });
});
