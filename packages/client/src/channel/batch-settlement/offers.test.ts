import { describe, it, expect } from 'vitest';
import {
  chooseBatchSettlement,
  offerFromTerms,
  parseBatchSettlementOffer,
  parseBatchSettlementTerms,
} from './offers.js';
import { parseX402Body } from '../../connector/x402.js';
import { parseSelfDescription } from '../../connector/self-description.js';

// The two entries exactly as the connector writes them
// (`connector_domain::x402::batch_settlement_accept`, connector #1345, #1357).
const EVM_ACCEPT = {
  scheme: 'batch-settlement',
  network: 'eip155:84532',
  amount: '1000',
  asset: '0x49beE1Bc3e4Ea2aF5f6E7a1B5A7A4c7F16a9a9Ce',
  payTo: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  maxTimeoutSeconds: 60,
  extra: {
    receiverAuthorizer: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    withdrawDelay: 86_400,
    name: 'USDC',
    version: '2',
  },
};

const SOLANA_ACCEPT = {
  scheme: 'batch-settlement',
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  amount: '1000',
  asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  payTo: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
  maxTimeoutSeconds: 60,
  extra: {
    feePayer: '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu',
    withdrawDelay: 86_400,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    minDeposit: '1000000',
    sponsorEndpoint: '/ilp/batch-settlement/solana/open',
  },
};

const TOON_CHANNEL_ACCEPT = {
  scheme: 'toon-channel',
  network: 'evm:84532',
  amount: '1000',
  payTo: 'g.toon.node',
  extra: { ilpAddress: 'g.toon.node', endpoint: '/ilp', price: '1000' },
};

/** `batchSettlements` terms: the offer's facts without the per-route amount. */
function terms(accept: typeof EVM_ACCEPT | typeof SOLANA_ACCEPT) {
  const {
    scheme: _s,
    amount: _a,
    maxTimeoutSeconds: _m,
    extra,
    ...rest
  } = accept;
  return { ...rest, ...extra };
}

describe('parseBatchSettlementOffer', () => {
  it('reads an EVM entry', () => {
    expect(parseBatchSettlementOffer(EVM_ACCEPT)).toEqual({
      chain: 'evm',
      offer: EVM_ACCEPT,
    });
  });

  it('reads a Solana entry, with the sponsor endpoint and minimum deposit', () => {
    expect(parseBatchSettlementOffer(SOLANA_ACCEPT)).toEqual({
      chain: 'solana',
      offer: SOLANA_ACCEPT,
    });
  });

  it('ignores a toon-channel entry, and anything malformed', () => {
    expect(parseBatchSettlementOffer(TOON_CHANNEL_ACCEPT)).toBeUndefined();
    expect(
      parseBatchSettlementOffer({ ...EVM_ACCEPT, network: 'cosmos:1' })
    ).toBeUndefined();
    expect(
      parseBatchSettlementOffer({
        ...EVM_ACCEPT,
        extra: { withdrawDelay: 86_400 },
      })
    ).toBeUndefined();
    expect(
      parseBatchSettlementOffer({
        ...SOLANA_ACCEPT,
        extra: { ...SOLANA_ACCEPT.extra, feePayer: undefined },
      })
    ).toBeUndefined();
    expect(
      parseBatchSettlementOffer({ ...EVM_ACCEPT, amount: 'lots' })
    ).toBeUndefined();
    expect(parseBatchSettlementOffer(null)).toBeUndefined();
  });
});

describe('parseBatchSettlementTerms and offerFromTerms', () => {
  it('reads the self-description facts, and prices them into the greeting’s offer', () => {
    const evm = parseBatchSettlementTerms(terms(EVM_ACCEPT));
    const solana = parseBatchSettlementTerms(terms(SOLANA_ACCEPT));
    expect(evm?.chain).toBe('evm');
    expect(solana?.chain).toBe('solana');
    expect(offerFromTerms(evm!, 1000n)).toEqual({
      chain: 'evm',
      offer: EVM_ACCEPT,
    });
    expect(offerFromTerms(solana!, 1000n)).toEqual({
      chain: 'solana',
      offer: SOLANA_ACCEPT,
    });
  });
});

describe('the greeting and the self-description', () => {
  it('keep the toon-channel entry, and add every batch-settlement entry', () => {
    const parsed = parseX402Body(
      {
        x402Version: 2,
        accepts: [EVM_ACCEPT, TOON_CHANNEL_ACCEPT, SOLANA_ACCEPT],
      },
      'https://node.example'
    );
    expect(parsed.toonChannel?.destination).toBe('g.toon.node');
    expect(parsed.batchSettlements).toEqual([
      { chain: 'evm', offer: EVM_ACCEPT },
      { chain: 'solana', offer: SOLANA_ACCEPT },
    ]);
  });

  it('a greeting offering only toon-channel parses exactly as before', () => {
    const parsed = parseX402Body(
      { x402Version: 2, accepts: [TOON_CHANNEL_ACCEPT] },
      'https://n'
    );
    expect(parsed.batchSettlements).toBeUndefined();
    expect(Object.keys(parsed).sort()).toEqual(['toonChannel', 'x402Version']);
  });

  it('GET /ilp publishes the same facts under batchSettlements', () => {
    const desc = parseSelfDescription({
      ilpAddresses: ['g.toon.node'],
      batchSettlements: [
        terms(EVM_ACCEPT),
        terms(SOLANA_ACCEPT),
        { network: 'eip155:1' },
      ],
    });
    expect(desc.batchSettlements.map((t) => t.chain)).toEqual([
      'evm',
      'solana',
    ]);
    expect(parseSelfDescription({ ilpAddresses: [] }).batchSettlements).toEqual(
      []
    );
  });
});

describe('chooseBatchSettlement', () => {
  const desc = parseSelfDescription({
    ilpAddresses: ['g.toon.node'],
    batchSettlements: [terms(EVM_ACCEPT), terms(SOLANA_ACCEPT)],
  });

  it('picks the offer on the chain the client pays from', () => {
    expect(chooseBatchSettlement(desc, 'evm')?.chain).toBe('evm');
    expect(chooseBatchSettlement(desc, 'solana')?.chain).toBe('solana');
  });

  it('answers nothing when the node offers none on that chain', () => {
    const evmOnly = parseSelfDescription({
      batchSettlements: [terms(EVM_ACCEPT)],
    });
    expect(chooseBatchSettlement(evmOnly, 'solana')).toBeUndefined();
    expect(
      chooseBatchSettlement(parseSelfDescription({}), 'evm')
    ).toBeUndefined();
  });

  it('prefers the network the client names, when the node offers more than one', () => {
    const two = parseSelfDescription({
      batchSettlements: [
        terms(EVM_ACCEPT),
        { ...terms(EVM_ACCEPT), network: 'eip155:8453' },
      ],
    });
    expect(chooseBatchSettlement(two, 'evm', 'eip155:8453')?.network).toBe(
      'eip155:8453'
    );
    expect(chooseBatchSettlement(two, 'evm', 'eip155:1')).toBeUndefined();
  });
});
