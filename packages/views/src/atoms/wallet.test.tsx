import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { walletAtoms, formatUnits } from './wallet.js';
import { type AtomRenderProps, type AtomBalance, type AtomChannel } from './types.js';

afterEach(cleanup);

const byId = (id: string) => walletAtoms.find((a) => a.id === id)!.Component;
const base: Omit<AtomRenderProps, 'props'> = {
  events: [],
  actions: {},
  children: null,
  renderEvent: () => null,
};

describe('formatUnits', () => {
  it('scales micro-units and groups thousands', () => {
    expect(formatUnits('125500000', 6)).toBe('125.5');
    expect(formatUnits('1234567000000', 6)).toBe('1,234,567');
    expect(formatUnits('0', 6)).toBe('0');
    expect(formatUnits('800000', 6)).toBe('0.8');
  });
  it('trims to at most 4 fractional places', () => {
    expect(formatUnits('1000001', 6)).toBe('1'); // 1.000001 → trimmed
    expect(formatUnits('1500050', 6)).toBe('1.5'); // trailing zeros trimmed
  });
});

describe('wallet-overview', () => {
  const identity = {
    nostrPubkey: 'npub1abc',
    evmAddress: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    solanaAddress: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  };
  const status = { feePerEvent: '1', settlementChain: 'evm', asset: 'USDC', identity } as const;
  const balances: AtomBalance[] = [
    { chain: 'evm', address: identity.evmAddress, amount: '125500000', asset: 'USDC', assetScale: 6 },
    { chain: 'solana', address: identity.solanaAddress, amount: '48200000', asset: 'USDC', assetScale: 6 },
  ];

  it('renders per-chain addresses from identity, enriched with balances', async () => {
    const Wallet = byId('wallet-overview');
    render(
      <Wallet
        {...base}
        props={{}}
        readStatus={() => Promise.resolve(status)}
        readBalances={() => Promise.resolve(balances)}
      />
    );
    expect(await screen.findByText('EVM')).toBeTruthy();
    expect(screen.getByText('Solana')).toBeTruthy();
    expect(await screen.findByText('125.5')).toBeTruthy();
    expect(screen.getByText('48.2')).toBeTruthy();
  });

  it('still shows addresses when balances are absent', async () => {
    const Wallet = byId('wallet-overview');
    render(<Wallet {...base} props={{}} readStatus={() => Promise.resolve(status)} />);
    expect(await screen.findByText('EVM')).toBeTruthy();
    expect(screen.getByText('Solana')).toBeTruthy();
  });

  it('fires the fund action with the row chain', async () => {
    const Wallet = byId('wallet-overview');
    const fund = vi.fn(() => Promise.resolve({ ok: true }));
    render(
      <Wallet
        {...base}
        props={{}}
        actions={{ fund }}
        readStatus={() => Promise.resolve(status)}
        readBalances={() => Promise.resolve(balances)}
      />
    );
    await screen.findByText('EVM');
    fireEvent.click(screen.getAllByRole('button', { name: 'Fund' })[0]!);
    expect(fund).toHaveBeenCalledWith({ chain: 'evm' });
  });

  it('shows an empty state when no identity is available', async () => {
    const Wallet = byId('wallet-overview');
    render(<Wallet {...base} props={{}} readStatus={() => Promise.reject(new Error('boom'))} />);
    await waitFor(() => expect(screen.getByText(/No wallet addresses/i)).toBeTruthy());
  });
});

describe('channel-list', () => {
  const channels: AtomChannel[] = [
    { channelId: '0xCH4NN3L00aa11bb22cc33dd44ee55ff', nonce: 42, cumulativeAmount: '4500000', depositTotal: '10000000', availableBalance: '5500000' },
  ];

  it('renders channels with available / deposit balance from readChannels', async () => {
    const ChannelList = byId('channel-list');
    render(<ChannelList {...base} props={{}} readChannels={() => Promise.resolve(channels)} />);
    expect(await screen.findByText('42')).toBeTruthy();
    expect(screen.getByText('5.5')).toBeTruthy();
    expect(screen.getByText(/\/\s*10/)).toBeTruthy();
  });

  it('shows the empty state for no channels', async () => {
    const ChannelList = byId('channel-list');
    render(<ChannelList {...base} props={{}} readChannels={() => Promise.resolve([])} />);
    expect(await screen.findByText(/No channels open yet/i)).toBeTruthy();
  });
});

describe('deposit-form', () => {
  const channels: AtomChannel[] = [
    { channelId: '0xCH4NN3L00aa11bb22cc33dd44ee55ff', nonce: 1, cumulativeAmount: '0', depositTotal: '10000000', availableBalance: '10000000' },
  ];

  it('deposits the entered amount and shows the new total', async () => {
    const DepositForm = byId('deposit-form');
    const deposit = vi.fn(() => Promise.resolve({ ok: true, data: { depositTotal: '15000000' } }));
    render(
      <DepositForm {...base} props={{}} actions={{ deposit }} readChannels={() => Promise.resolve(channels)} />
    );
    // Channel auto-selected; enter an amount and submit.
    const input = await screen.findByPlaceholderText('1000000');
    fireEvent.change(input, { target: { value: '5000000' } });
    fireEvent.click(screen.getByRole('button', { name: /Deposit/i }));
    await waitFor(() =>
      expect(deposit).toHaveBeenCalledWith({ channelId: channels[0]!.channelId, amount: '5000000' })
    );
    expect(await screen.findByText(/New deposit total/i)).toBeTruthy();
    expect(screen.getByText('15')).toBeTruthy(); // 15000000 micro → 15
  });

  it('surfaces a deposit failure without a receipt', async () => {
    const DepositForm = byId('deposit-form');
    const deposit = vi.fn(() => Promise.resolve({ ok: false, error: 'insufficient funds' }));
    render(
      <DepositForm {...base} props={{}} actions={{ deposit }} readChannels={() => Promise.resolve(channels)} />
    );
    fireEvent.change(await screen.findByPlaceholderText('1000000'), { target: { value: '5000000' } });
    fireEvent.click(screen.getByRole('button', { name: /Deposit/i }));
    expect(await screen.findByText(/insufficient funds/i)).toBeTruthy();
  });
});
