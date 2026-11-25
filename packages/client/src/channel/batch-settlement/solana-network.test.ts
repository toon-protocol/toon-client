/**
 * The Solana settlement network's voucher scheme, through the settlement
 * network interface, against the connector's wire vectors: the voucher's claim
 * and the claim-state challenge, byte for byte.
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { SolanaSettlementNetwork } from './solana-network.js';
import type { BatchChannel } from './manager.js';
import { hexToBytes, loadWireVectors } from '../../wire/vectors/load.js';
import { must } from '../../utils/must.test-support.js';

const vectors = loadWireVectors();

// The connector's fixture key for the Solana voucher: 32 bytes of 0x21.
const VOUCHER_KEY = new Uint8Array(32).fill(0x21);

const noFetch = (async () => {
  throw new Error('the voucher scheme reaches nothing');
}) as typeof fetch;

function network(privateKey: Uint8Array): SolanaSettlementNetwork {
  return new SolanaSettlementNetwork({
    signer: { privateKey, publicKey: ed25519.getPublicKey(privateKey) },
    rpc: { url: 'http://rpc.invalid', fetch: noFetch },
    fetch: noFetch,
    connector: 'https://node.example',
  });
}

/** A Solana channel at `channelId`; the voucher scheme reads only its id. */
function channelAt(channelId: string): BatchChannel {
  return {
    chain: 'solana',
    channelId,
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    sponsor: channelId,
    config: {} as Extract<BatchChannel, { chain: 'solana' }>['config'],
  };
}

describe('the Solana settlement network', () => {
  it('pays on solana networks only, and replaces rather than tops up', () => {
    const n = network(VOUCHER_KEY);
    expect(n.serves('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe(true);
    expect(n.serves('eip155:84532')).toBe(false);
    expect(n.cover).toEqual({
      kind: 'replace',
      noTopUp:
        'a Solana batch-settlement channel is not topped up: the next payment it cannot cover opens a fresh sponsored one',
    });
  });

  it('voucher scheme: signs the published voucher into the published claim, byte for byte', async () => {
    const v = must(vectors.claim_voucher).solana;
    const claim = await network(VOUCHER_KEY).voucher(
      channelAt(v.channel_account_base58),
      BigInt(v.max_claimable_amount)
    );
    const published = JSON.parse(v.json) as Record<string, unknown>;
    expect(
      JSON.stringify({
        ...claim,
        messageId: published['messageId'],
        timestamp: published['timestamp'],
      })
    ).toBe(v.json);
  });

  it.each(
    must(vectors.voucher_claim_state_challenge).solana.map(
      (c) => [c.name, c] as const
    )
  )('claim-state challenge: %s', async (_name, c) => {
    const entry = await network(hexToBytes(c.signer_secret_hex)).challenge(
      channelAt(c.channel_account_base58),
      BigInt(c.expires)
    );
    expect(JSON.stringify(entry)).toBe(c.entry_json);
  });
});
