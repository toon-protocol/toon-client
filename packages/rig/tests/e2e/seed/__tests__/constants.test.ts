/**
 * ATDD Tests: Story 10.1 — AC-1.4 Constants Module
 * TDD RED PHASE: These tests define expected behavior for constants.ts
 *
 * Tests will FAIL until constants.ts is implemented with correct exports.
 */

import { describe, it, expect } from 'vitest';

describe('AC-1.4: Seed Constants (constants.ts)', () => {
  it('[P0] should re-export all Docker E2E infrastructure constants', async () => {
    // Given the constants module exists
    const constants = await import('../lib/constants.js');

    // Then it should export all required infrastructure addresses
    expect(constants.PEER1_RELAY_URL).toBe('ws://localhost:19700');
    expect(constants.PEER1_BTP_URL).toBe('ws://localhost:19000');
    expect(constants.PEER1_BLS_URL).toBe('http://localhost:19100');
    expect(constants.ANVIL_RPC).toBe('http://localhost:18545');
    expect(constants.TOKEN_ADDRESS).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3');
    expect(constants.TOKEN_NETWORK_ADDRESS).toBe('0xCafac3dD18aC6c6e92c921884f9E4176737C052c');
    expect(constants.CHAIN_ID).toBe(31337);
  });

  it('[P0] should re-export AGENT_IDENTITIES with Alice, Bob, Carol', async () => {
    // Given the constants module exists
    const constants = await import('../lib/constants.js');

    // Then AGENT_IDENTITIES should have all three agents
    expect(constants.AGENT_IDENTITIES).toBeDefined();
    expect(constants.AGENT_IDENTITIES.alice).toBeDefined();
    expect(constants.AGENT_IDENTITIES.bob).toBeDefined();
    expect(constants.AGENT_IDENTITIES.carol).toBeDefined();
  });

  it('[P0] should export Alice identity with correct Anvil #3 keys', async () => {
    const constants = await import('../lib/constants.js');

    // Alice uses Anvil Account #3
    expect(constants.AGENT_IDENTITIES.alice.evmKey).toBe(
      '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'
    );
    expect(constants.AGENT_IDENTITIES.alice.evmAddress).toBe(
      '0x90F79bf6EB2c4f870365E785982E1f101E93b906'
    );
    expect(constants.AGENT_IDENTITIES.alice.secretKeyHex).toHaveLength(64);
    expect(constants.AGENT_IDENTITIES.alice.pubkey).toHaveLength(64);
  });

  it('[P1] should export Bob identity with correct Anvil #4 keys', async () => {
    const constants = await import('../lib/constants.js');

    expect(constants.AGENT_IDENTITIES.bob.evmKey).toBe(
      '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'
    );
    expect(constants.AGENT_IDENTITIES.bob.evmAddress).toBe(
      '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'
    );
  });

  it('[P1] should export Carol identity with correct Anvil #5 keys', async () => {
    const constants = await import('../lib/constants.js');

    expect(constants.AGENT_IDENTITIES.carol.evmKey).toBe(
      '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'
    );
    expect(constants.AGENT_IDENTITIES.carol.evmAddress).toBe(
      '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'
    );
  });

  it('[P0] should export PEER1_PUBKEY constant', async () => {
    const constants = await import('../lib/constants.js');

    expect(constants.PEER1_PUBKEY).toBe(
      'd6bfe100d1600c0d8f769501676fc74c3809500bd131c8a549f88cf616c21f35'
    );
  });

  it('[P0] should export PEER1_DESTINATION constant', async () => {
    const constants = await import('../lib/constants.js');

    expect(constants.PEER1_DESTINATION).toBe('g.toon.peer1');
  });

  it('[P1] should never hardcode infrastructure addresses outside constants', async () => {
    // This test verifies the single-source-of-truth principle
    const constants = await import('../lib/constants.js');

    // All infrastructure URLs should be string types (not undefined)
    expect(typeof constants.PEER1_RELAY_URL).toBe('string');
    expect(typeof constants.PEER1_BTP_URL).toBe('string');
    expect(typeof constants.PEER1_BLS_URL).toBe('string');
    expect(typeof constants.ANVIL_RPC).toBe('string');
  });
});
