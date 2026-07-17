/**
 * Tests for the per-repo Rig-pointer record: roundtrip, per-repo keying, and
 * the corrupt-file tolerance a paid push must never trip over.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RIG_POINTER_FILENAME,
  readRigPointerRecord,
  writeRigPointerRecord,
  type RigPointerRecord,
} from './rig-pointer-record.js';

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'toon-rig-pointerrec-'));
  env = { TOON_CLIENT_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function record(overrides: Partial<RigPointerRecord> = {}): RigPointerRecord {
  return {
    repoId: 'hello-toon',
    owner: 'd4'.repeat(32),
    pointerTxId: 'A'.repeat(43),
    contentHash: 'b1'.repeat(32),
    updatedAt: 1_752_000_000_000,
    ...overrides,
  };
}

describe('rig-pointer record', () => {
  it('roundtrips a record and keys by repoId', () => {
    writeRigPointerRecord(env, record());
    writeRigPointerRecord(env, record({ repoId: 'other', pointerTxId: 'B'.repeat(43) }));
    expect(readRigPointerRecord(env, 'hello-toon')?.pointerTxId).toBe('A'.repeat(43));
    expect(readRigPointerRecord(env, 'other')?.pointerTxId).toBe('B'.repeat(43));
    expect(readRigPointerRecord(env, 'missing')).toBeUndefined();
  });

  it('a later write for the same repo replaces the record', () => {
    writeRigPointerRecord(env, record());
    writeRigPointerRecord(env, record({ contentHash: 'c2'.repeat(32) }));
    expect(readRigPointerRecord(env, 'hello-toon')?.contentHash).toBe('c2'.repeat(32));
  });

  it('treats a corrupt store as empty and recovers on write', () => {
    writeFileSync(join(home, RIG_POINTER_FILENAME), '{nope');
    expect(readRigPointerRecord(env, 'hello-toon')).toBeUndefined();
    writeRigPointerRecord(env, record());
    expect(readRigPointerRecord(env, 'hello-toon')).toBeDefined();
  });
});
