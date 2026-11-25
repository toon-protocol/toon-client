/**
 * The EVM settlement network's voucher scheme, through the settlement network
 * interface, against the connector's wire vectors: the voucher's claim and the
 * claim-state challenge, byte for byte.
 */
import { describe, it, expect } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmSettlementNetwork } from './evm-network.js';
import type { BatchChannel } from './manager.js';
import { loadWireVectors } from '../../wire/vectors/load.js';
import { must } from '../../utils/must.test-support.js';

const vectors = loadWireVectors();
const prefix0x = (hex: string): Hex => `0x${hex}`;

// The connector's fixture keys: anvil account 1, and `seq_bytes(0xe1)`.
const ANVIL_ACCOUNT_1_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ABOVE_U64_MAX_KEY = `0x${Array.from({ length: 32 }, (_, i) =>
  ((0xe1 + i) & 0xff).toString(16).padStart(2, '0')
).join('')}` as Hex;

const noFetch = (async () => {
  throw new Error('the voucher scheme reaches nothing');
}) as typeof fetch;

function network(key: Hex): EvmSettlementNetwork {
  return new EvmSettlementNetwork({
    account: privateKeyToAccount(key),
    fetch: noFetch,
  });
}

/** The claim as the network wrote it, with the published envelope's id and time. */
function withEnvelope(claim: Record<string, unknown>, json: string): string {
  const published = JSON.parse(json) as Record<string, unknown>;
  return JSON.stringify({
    ...claim,
    messageId: published['messageId'],
    timestamp: published['timestamp'],
  });
}

describe('the EVM settlement network', () => {
  it('pays on eip155 networks only', () => {
    const n = network(ANVIL_ACCOUNT_1_KEY);
    expect(n.serves('eip155:84532')).toBe(true);
    expect(n.serves('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe(false);
    expect(n.cover.kind).toBe('top-up');
  });

  describe.each([
    ['evm', must(vectors.claim_voucher).evm, ANVIL_ACCOUNT_1_KEY],
    [
      'evm_above_u64_max',
      must(vectors.claim_voucher).evm_above_u64_max,
      ABOVE_U64_MAX_KEY,
    ],
  ] as const)('voucher scheme: %s', (_label, v, key) => {
    const channel: BatchChannel = {
      chain: 'evm',
      channelId: prefix0x(v.channel_id_hex),
      network: `eip155:${v.chain_id}`,
      config: {
        payer: getAddress(prefix0x(v.channel_config.payer_hex)),
        payerAuthorizer: getAddress(
          prefix0x(v.channel_config.payer_authorizer_hex)
        ),
        receiver: getAddress(prefix0x(v.channel_config.receiver_hex)),
        receiverAuthorizer: getAddress(
          prefix0x(v.channel_config.receiver_authorizer_hex)
        ),
        token: getAddress(prefix0x(v.channel_config.token_hex)),
        withdrawDelay: v.channel_config.withdraw_delay,
        salt: prefix0x(v.channel_config.salt_hex),
      },
    };

    it('signs the published voucher into the published claim, byte for byte', async () => {
      const claim = await network(key).voucher(
        channel,
        BigInt(v.max_claimable_amount)
      );
      expect(claim['signature']).toBe(prefix0x(v.signature_hex));
      expect(withEnvelope(claim, v.json)).toBe(v.json);
    });
  });

  it.each(
    must(vectors.voucher_claim_state_challenge).evm.map(
      (c) => [c.name, c] as const
    )
  )('claim-state challenge: %s', async (_name, c) => {
    const cc = (
      JSON.parse(c.entry_json) as {
        channelConfig: Record<string, string | number>;
      }
    ).channelConfig;
    const channel: BatchChannel = {
      chain: 'evm',
      channelId: prefix0x(c.channel_id_hex),
      network: `eip155:${c.chain_id}`,
      config: {
        payer: String(cc['payer']),
        payerAuthorizer: String(cc['payerAuthorizer']),
        receiver: String(cc['receiver']),
        receiverAuthorizer: String(cc['receiverAuthorizer']),
        token: String(cc['token']),
        withdrawDelay: Number(cc['withdrawDelay']),
        salt: String(cc['salt']) as Hex,
      },
    };
    const entry = await network(prefix0x(c.signer_secret_hex)).challenge(
      channel,
      BigInt(c.expires)
    );
    expect(JSON.stringify(entry)).toBe(c.entry_json);
  });
});
