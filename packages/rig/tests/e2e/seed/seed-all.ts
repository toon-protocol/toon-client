/**
 * Seed Orchestrator — Playwright globalSetup entry point.
 *
 * Runs all 8 push scripts in sequence, checks infrastructure health,
 * manages freshness via state.json, and exports typed state for Playwright specs.
 *
 * Story 10.9: AC-9.1 through AC-9.6
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  createSeedClients,
  stopAllClients,
  AGENT_IDENTITIES,
  PEER1_BLS_URL,
  PEER2_BLS_URL,
  ANVIL_RPC,
  type ShaToTxIdMap,
} from './lib/index.js';
import { runPush01 } from './push-01-init.js';
import { runPush02 } from './push-02-nested.js';
import { runPush03 } from './push-03-branch.js';
import { runPush04 } from './push-04-branch-work.js';
import { runPush05 } from './push-05-tag.js';
import { runPush06 } from './push-06-prs.js';
import { runPush07 } from './push-07-issues.js';
import { runPush08 } from './push-08-close.js';

// ---------------------------------------------------------------------------
// File path for state.json
// ---------------------------------------------------------------------------

const __dirname =
  import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'state.json');

// ---------------------------------------------------------------------------
// SeedState interface (Push08State + generatedAt)
// ---------------------------------------------------------------------------

export interface SeedState {
  generatedAt: string;
  repoId: string;
  ownerPubkey: string;
  commits: { sha: string; txId: string; message: string }[];
  shaMap: Record<string, string>;
  repoAnnouncementId: string;
  refsEventId: string;
  branches: string[];
  tags: string[];
  files: string[];
  prs: {
    eventId: string;
    title: string;
    authorPubkey: string;
    statusKind: 1630 | 1631 | 1632 | 1633;
  }[];
  issues: {
    eventId: string;
    title: string;
    authorPubkey: string;
    labels: string[];
  }[];
  comments: {
    eventId: string;
    issueEventId: string;
    authorPubkey: string;
    body: string;
  }[];
  closedIssueEventIds: string[];
}

// ---------------------------------------------------------------------------
// State persistence helpers (AC-9.3, AC-9.5)
// ---------------------------------------------------------------------------

export function saveSeedState(state: Omit<SeedState, 'generatedAt'>): void {
  const seedState: SeedState = {
    ...state,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(seedState, null, 2), 'utf-8');
  console.log(
    `[seed] State saved to state.json (generatedAt: ${seedState.generatedAt})`
  );
}

export function loadSeedState(): SeedState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const raw = readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as SeedState;
  } catch {
    return null;
  }
}

export function isFresh(state: SeedState, ttlMs = 10 * 60 * 1000): boolean {
  return Date.now() - Date.parse(state.generatedAt) < ttlMs;
}

// ---------------------------------------------------------------------------
// Service readiness check (AC-9.1)
// ---------------------------------------------------------------------------

async function pollService(
  name: string,
  url: string,
  method: 'GET' | 'POST',
  body?: string,
  timeoutMs = 30000
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const opts: RequestInit = {
        method,
        signal: AbortSignal.timeout(2000),
      };
      if (body) {
        opts.body = body;
        opts.headers = { 'Content-Type': 'application/json' };
      }
      const res = await fetch(url, opts);
      if (method === 'GET' && res.ok) return null;
      if (method === 'POST') {
        // Anvil JSON-RPC: any response is healthy
        const text = await res.text();
        if (text) return null;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return `${name} (${url})`;
}

export async function checkAllServicesReady(): Promise<void> {
  console.log('[seed] Checking service readiness...');

  const results = await Promise.all([
    pollService('Peer1 BLS', `${PEER1_BLS_URL}/health`, 'GET'),
    pollService('Peer2 BLS', `${PEER2_BLS_URL}/health`, 'GET'),
    pollService(
      'Anvil',
      ANVIL_RPC,
      'POST',
      '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
    ),
  ]);

  const failures = results.filter((r): r is string => r !== null);
  if (failures.length > 0) {
    throw new Error(`Services not ready: ${failures.join(', ')}`);
  }

  console.log('[seed] All services ready');
}

// ---------------------------------------------------------------------------
// Push descriptions for logging
// ---------------------------------------------------------------------------

const PUSH_DESCRIPTIONS = [
  'initial repo',
  'nested dirs',
  'feature branch',
  'branch work',
  'tag',
  'PRs with status',
  'issues, labels, conversations',
  'close issue',
];

// ---------------------------------------------------------------------------
// Default export: Playwright globalSetup (AC-9.4)
// ---------------------------------------------------------------------------

export default async function globalSetup(): Promise<void> {
  // AC-9.5: Freshness check
  const existing = loadSeedState();
  if (existing && isFresh(existing)) {
    console.log('[seed] state.json is fresh (< 10 min), skipping seed');
    return;
  }

  // Delete stale file if it exists
  if (existsSync(STATE_FILE)) {
    unlinkSync(STATE_FILE);
  }

  // AC-9.1: Check all services ready
  await checkAllServicesReady();

  // AC-9.2: Sequential push orchestration
  const { alice, bob, carol } = await createSeedClients();

  // Derive secret keys
  const aliceKey = Uint8Array.from(
    Buffer.from(AGENT_IDENTITIES.alice.secretKeyHex, 'hex')
  );
  const bobKey = Uint8Array.from(
    Buffer.from(AGENT_IDENTITIES.bob.secretKeyHex, 'hex')
  );
  const carolKey = Uint8Array.from(
    Buffer.from(AGENT_IDENTITIES.carol.secretKeyHex, 'hex')
  );

  const shaMap: ShaToTxIdMap = {};
  const startTime = Date.now();

  try {
    // Push 1/8
    const push01State = await runPush01(alice, aliceKey, shaMap);
    console.log(`[seed] Push 1/8 complete (${PUSH_DESCRIPTIONS[0]})`);

    // Push 2/8
    const push02State = await runPush02(alice, aliceKey, push01State);
    console.log(`[seed] Push 2/8 complete (${PUSH_DESCRIPTIONS[1]})`);

    // Push 3/8
    const push03State = await runPush03(alice, aliceKey, push02State);
    console.log(`[seed] Push 3/8 complete (${PUSH_DESCRIPTIONS[2]})`);

    // Push 4/8
    const push04State = await runPush04(alice, aliceKey, push03State);
    console.log(`[seed] Push 4/8 complete (${PUSH_DESCRIPTIONS[3]})`);

    // Push 5/8
    const push05State = await runPush05(alice, aliceKey, push04State);
    console.log(`[seed] Push 5/8 complete (${PUSH_DESCRIPTIONS[4]})`);

    // Push 6/8
    const push06State = await runPush06(
      alice,
      carol,
      aliceKey,
      carolKey,
      push05State
    );
    console.log(`[seed] Push 6/8 complete (${PUSH_DESCRIPTIONS[5]})`);

    // Push 7/8
    const push07State = await runPush07(
      alice,
      bob,
      carol,
      aliceKey,
      bobKey,
      carolKey,
      push06State
    );
    console.log(`[seed] Push 7/8 complete (${PUSH_DESCRIPTIONS[6]})`);

    // Push 8/8
    const push08State = await runPush08(alice, aliceKey, push07State);
    console.log(`[seed] Push 8/8 complete (${PUSH_DESCRIPTIONS[7]})`);

    // AC-9.3: Save state
    saveSeedState(push08State);

    // AC-9.6: Timing report
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[seed] Total seed time: ${elapsed}s`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[seed] Seed failed: ${message}`);
    throw err;
  } finally {
    await stopAllClients();
  }
}
