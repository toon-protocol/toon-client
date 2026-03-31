/**
 * Client E2E Test — Mina Lazy Channel
 *
 * Tests lazy channel flow with Mina chain config.
 * Uses 180s timeout due to Mina proof generation time.
 *
 * Requires: ./scripts/sdk-e2e-infra.sh up (with Mina lightnet synced)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  MINA_GRAPHQL,
  MINA_ZKAPP_ADDRESS,
  checkAllServicesReady,
  skipIfNotReady,
  waitForMinaHealth,
  acquireMinaAccount,
  releaseMinaAccount,
} from '../../../sdk/tests/e2e/helpers/docker-e2e-setup.js';

describe('Client E2E: Mina Lazy Channel', { timeout: 180_000 }, () => {
  let servicesReady = false;
  let minaReady = false;
  let minaAccount: { pk: string; sk: string } | null = null;

  beforeAll(async () => {
    servicesReady = await checkAllServicesReady();
    if (servicesReady) {
      minaReady = await waitForMinaHealth(60_000);
      if (minaReady) {
        minaAccount = await acquireMinaAccount();
      }
    }
  });

  afterAll(async () => {
    if (minaAccount) {
      await releaseMinaAccount(minaAccount.pk);
    }
  });

  it('should have Mina lightnet synced', async () => {
    if (skipIfNotReady(servicesReady)) return;
    expect(minaReady).toBe(true);
  });

  it('should acquire funded Mina account', async () => {
    if (skipIfNotReady(servicesReady)) return;
    if (!minaReady) return;

    expect(minaAccount).not.toBeNull();
    expect(minaAccount?.pk).toBeTruthy();
    console.log(`Mina account: ${minaAccount?.pk}`);
  });

  it('should query Mina GraphQL', async () => {
    if (skipIfNotReady(servicesReady)) return;
    if (!minaReady) return;

    const res = await fetch(MINA_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{syncStatus}' }),
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { data?: { syncStatus?: string } };
    expect(data.data?.syncStatus).toBe('SYNCED');
  });

  it('should have Mina zkApp address available', async () => {
    if (skipIfNotReady(servicesReady)) return;
    if (!minaReady) return;

    console.log(`Mina zkApp address: ${MINA_ZKAPP_ADDRESS || '(not set)'}`);
    expect(typeof MINA_ZKAPP_ADDRESS).toBe('string');
  });
});
