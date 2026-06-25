import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { statusAtoms } from './status.js';
import { type AtomRenderProps, type AtomStatus } from './types.js';

afterEach(cleanup);

const ClientStatus = statusAtoms.find((a) => a.id === 'client-status')!.Component;
const base: Omit<AtomRenderProps, 'readStatus'> = {
  events: [],
  props: {},
  actions: {},
  children: null,
  renderEvent: () => null,
};

const fullStatus: AtomStatus = {
  feePerEvent: '10',
  asset: 'USDC',
  settlementChain: 'evm',
  uptimeMs: 3_725_000, // 1h 2m
  ready: true,
  bootstrapping: false,
  identity: {
    nostrPubkey: 'npub1examplepubkeyabcdefghijklmnopqrstuvwxyz',
    evmAddress: '0xabc1234567890def',
  },
  transport: { type: 'direct', btpUrl: 'btp+wss://apex.example' },
  relay: {
    url: 'wss://relay.example',
    connected: true,
    buffered: 7,
    subscriptions: ['sub-a', 'sub-b'],
  },
  network: [
    { chain: 'evm', ready: true },
    { chain: 'solana', ready: false, detail: 'no channel' },
    { chain: 'mina', ready: true },
  ],
};

describe('client-status', () => {
  it('renders the daemon health snapshot from readStatus', async () => {
    const readStatus = vi.fn().mockResolvedValue(fullStatus);
    render(<ClientStatus {...base} readStatus={readStatus} />);

    // state badge
    expect(await screen.findByText('Ready')).toBeTruthy();
    // uptime
    expect(screen.getByText(/up 1h 2m/)).toBeTruthy();
    // settlement + fee ('evm' appears as both the settlement value and a chain badge)
    expect(screen.getAllByText('evm').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('10 USDC')).toBeTruthy();
    // relay
    expect(screen.getByText('wss://relay.example')).toBeTruthy();
    expect(screen.getByText('connected')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy(); // buffered
    expect(screen.getByText('2')).toBeTruthy(); // subscriptions count
    // chains as badges (solana not ready still shown)
    expect(screen.getByText('solana')).toBeTruthy();
    expect(screen.getByText('mina')).toBeTruthy();
    // identity
    expect(screen.getByText('npub')).toBeTruthy();
    expect(screen.getByText('EVM')).toBeTruthy();
  });

  it('shows a bootstrapping badge when not yet ready', async () => {
    const readStatus = vi.fn().mockResolvedValue({
      feePerEvent: '10',
      settlementChain: 'evm',
      ready: false,
      bootstrapping: true,
    } satisfies AtomStatus);
    render(<ClientStatus {...base} readStatus={readStatus} />);
    expect(await screen.findByText('Bootstrapping')).toBeTruthy();
  });

  it('renders an unavailable state when readStatus rejects', async () => {
    const readStatus = vi.fn().mockRejectedValue(new Error('down'));
    render(<ClientStatus {...base} readStatus={readStatus} />);
    expect(await screen.findByText(/status is unavailable/i)).toBeTruthy();
  });

  it('handles a missing readStatus seam gracefully (no crash)', () => {
    render(<ClientStatus {...base} />);
    expect(screen.getByText(/status is unavailable/i)).toBeTruthy();
  });
});
