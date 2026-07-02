/**
 * `rig fund` tests (#263): the devnet faucet call shape (the exact POST the
 * e2e drips with — `{faucet}/api/request` + `{ address }` body, per-chain
 * paths), faucet-URL resolution (env → config → devnet default), the
 * non-devnet guidance path (addresses printed, nothing fetched), and error
 * surfacing. The fetch seam is injected; identity derivation is REAL (a
 * fixed test mnemonic), so the derived EVM address in the request body is
 * the one the client would fund.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVNET_FAUCET_URL, FUND_USAGE, runFund, type FundDeps } from './fund.js';
import type { CliIo } from './push.js';

/** Standard BIP-39 test vector phrase — deterministic addresses. */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

interface Harness {
  deps: FundDeps;
  out: string[];
  err: string[];
  fetchCalls: { url: string; init: RequestInit | undefined }[];
}

function makeHarness(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: { status?: number; body?: string } = {}
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const fetchCalls: Harness['fetchCalls'] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    isInteractive: false,
    confirm: async () => false,
  };
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(options.body ?? JSON.stringify({ success: true }), {
      status: options.status ?? 200,
    });
  }) as unknown as typeof fetch;
  return { deps: { io, env, cwd, fetchImpl }, out, err, fetchCalls };
}

describe('rig fund', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rig-fund-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'rig-fund-cwd-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>): void {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  }

  const baseEnv = (): NodeJS.ProcessEnv => ({
    RIG_MNEMONIC: MNEMONIC,
    TOON_CLIENT_HOME: home,
  });

  it('devnet: POSTs { address } to {faucet}/api/request with the derived EVM address', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--json'], h.deps)).toBe(0);

    expect(h.fetchCalls).toHaveLength(1);
    const call = h.fetchCalls[0] as Harness['fetchCalls'][0];
    expect(call.url).toBe(`${DEVNET_FAUCET_URL}/api/request`);
    expect(call.init?.method).toBe('POST');
    const body = JSON.parse(String(call.init?.body)) as { address: string };
    expect(body.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(Object.keys(body)).toEqual(['address']);

    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      command: 'fund',
      funded: true,
      network: 'devnet',
      chain: 'evm',
      address: body.address,
      faucetUrl: DEVNET_FAUCET_URL,
      response: { success: true },
    });
    expect(parsed['identity']).toMatchObject({ source: 'env' });
  });

  it('an explicit TOON_CLIENT_FAUCET_URL wins over the devnet default', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness(
      { ...baseEnv(), TOON_CLIENT_FAUCET_URL: 'https://faucet.example' },
      cwd
    );
    expect(await runFund([], h.deps)).toBe(0);
    expect(h.fetchCalls[0]?.url).toBe('https://faucet.example/api/request');
    expect(h.out.join('\n')).toContain('Faucet drip succeeded');
  });

  it('a configured faucetUrl enables funding regardless of network', async () => {
    writeConfig({ network: 'custom', faucetUrl: 'https://my-faucet.example' });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund([], h.deps)).toBe(0);
    expect(h.fetchCalls[0]?.url).toBe('https://my-faucet.example/api/request');
  });

  it('--chain solana uses the solana faucet path and a base58 address', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--chain', 'solana', '--json'], h.deps)).toBe(0);
    const call = h.fetchCalls[0] as Harness['fetchCalls'][0];
    expect(call.url).toBe(`${DEVNET_FAUCET_URL}/api/solana/request`);
    const body = JSON.parse(String(call.init?.body)) as { address: string };
    expect(body.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('the configured settlement chain is the default (config `chain` field)', async () => {
    writeConfig({ network: 'devnet', chain: 'solana' });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--json'], h.deps)).toBe(0);
    expect(h.fetchCalls[0]?.url).toBe(`${DEVNET_FAUCET_URL}/api/solana/request`);
  });

  it('--address overrides the derived address', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness(baseEnv(), cwd);
    expect(
      await runFund(['--address', '0x' + 'ab'.repeat(20)], h.deps)
    ).toBe(0);
    const body = JSON.parse(String(h.fetchCalls[0]?.init?.body)) as {
      address: string;
    };
    expect(body.address).toBe('0x' + 'ab'.repeat(20));
  });

  it('non-devnet without a faucet prints funding guidance + addresses (exit 0, no fetch)', async () => {
    writeConfig({ network: 'testnet' });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--json'], h.deps)).toBe(0);
    expect(h.fetchCalls).toEqual([]);
    const parsed = JSON.parse(h.out.join('\n')) as {
      funded: boolean;
      network: string;
      addresses: { evm: string | null; solana: string | null };
      guidance: string;
    };
    expect(parsed.funded).toBe(false);
    expect(parsed.network).toBe('testnet');
    expect(parsed.addresses.evm).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(parsed.addresses.solana).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(parsed.guidance).toMatch(/fund the wallet/i);
  });

  it('non-devnet human output lists the addresses per chain', async () => {
    writeConfig({}); // no network at all
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund([], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/no faucet on network "custom"/);
    expect(text).toMatch(/evm\s+0x[0-9a-fA-F]{40}/);
    expect(text).toContain('Wallet addresses:');
  });

  it('a non-2xx faucet response is a clear error (exit 1)', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness(baseEnv(), cwd, { status: 500, body: 'treasury empty' });
    expect(await runFund(['--json'], h.deps)).toBe(1);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed['command']).toBe('fund');
    expect(parsed['detail']).toMatch(/500/);
    expect(parsed['detail']).toMatch(/treasury empty/);
  });

  it('an unknown --chain is a usage error (exit 2, nothing fetched)', async () => {
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--chain', 'dogecoin'], h.deps)).toBe(2);
    expect(h.fetchCalls).toEqual([]);
    expect(h.err.join('\n')).toContain('--chain must be one of');
  });

  it('a missing identity surfaces the identity-chain remediation (exit 1)', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness({ TOON_CLIENT_HOME: home }, cwd);
    expect(await runFund(['--json'], h.deps)).toBe(1);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed['error']).toBe('missing_identity');
    expect(h.fetchCalls).toEqual([]);
  });

  it('--help prints usage without resolving any identity', async () => {
    const h = makeHarness({}, cwd);
    expect(await runFund(['--help'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toBe(FUND_USAGE);
  });
});
