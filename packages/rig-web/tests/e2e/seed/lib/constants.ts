/**
 * Seed library constants — single source of truth for E2E infrastructure addresses.
 *
 * Re-exports Docker E2E setup constants and AGENT_IDENTITIES from the socialverse harness.
 * Never hardcode infrastructure addresses in seed scripts — import from here.
 */

// Re-export Docker E2E infrastructure constants
export {
  ANVIL_RPC,
  PEER1_RELAY_URL,
  PEER1_BTP_URL,
  PEER1_BLS_URL,
  PEER2_BLS_URL,
  TOKEN_ADDRESS,
  TOKEN_NETWORK_ADDRESS,
  CHAIN_ID,
} from '../../../../../sdk/tests/e2e/helpers/docker-e2e-setup.js';

// Re-export AGENT_IDENTITIES from the socialverse harness
export {
  AGENT_IDENTITIES,
} from '../../../../../client/tests/e2e/socialverse-agent-harness.js';

// Peer1 Nostr public key (hex)
export const PEER1_PUBKEY =
  'd6bfe100d1600c0d8f769501676fc74c3809500bd131c8a549f88cf616c21f35';

// Peer1 ILP destination address
export const PEER1_DESTINATION = 'g.toon.peer1';
