/**
 * `rig fund` tests (#263, multi-chain by default): the devnet faucet call shape
 * (the exact POST the e2e drips with — `{faucet}/api/request` + `{ address }`
 * body, per-chain paths), the ALL-chains default (one run funds evm + solana +
 * mina), the parallel + independent-failure contract (one chain failing never
 * aborts the others; partial success renders and exits non-zero), faucet-URL
 * resolution (env → config → devnet default), the non-devnet guidance path
 * (addresses printed, nothing fetched), and error surfacing. The fetch seam is
 * injected; identity derivation is REAL (a fixed test mnemonic), so the derived
 * addresses in the request bodies are the ones the client would fund.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVNET_FAUCET_URL, FUND_USAGE, runFund, type FundDeps } from './fund.js';
import type { CliIo } from './push.js';

/** Standard BIP-39 test vector phrase — deterministic addresses. */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** The three faucet paths, in the fixed evm → solana → mina order. */
const EVM_PATH = '/api/request';
const SOLANA_PATH = '/api/solana/request';
const MINA_PATH = '/api/mina/request';

interface Harness {
  deps: FundDeps;
  out: string[];
  err: string[];
  fetchCalls: { url: string; init: RequestInit | undefined }[];
}

interface HarnessOptions {
  status?: number;
  body?: string;
  /** Per-URL response override (partial-failure tests). */
  respond?: (url: string) => { status?: number; body?: string } | undefined;
  /**
   * Prove concurrency: no faucet call resolves until THIS many have been
   * dispatched. Serial (await-in-loop) code stalls at 1 and never reaches the
   * barrier, so the test times out — only genuinely parallel drips pass.
   */
  barrier?: number;
}

function makeHarness(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: HarnessOptions = {}
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const fetchCalls: Harness['fetchCalls'] = [];
  let dispatched = 0;
  let releaseBarrier: () => void = () => {};
  const barrierReached = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    // The machine document lands in the same `out` stream the pre-#265
    // assertions read (production routes it to the real stdout).
    emitJson: (payload) => out.push(JSON.stringify(payload, null, 2)),
    isInteractive: false,
    confirm: async () => false,
  };
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    if (options.barrier) {
      dispatched += 1;
      if (dispatched >= options.barrier) releaseBarrier();
      await barrierReached;
    }
    const override = options.respond?.(String(url));
    const status = override?.status ?? options.status ?? 200;
    const body = override?.body ?? options.body ?? JSON.stringify({ success: true });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { deps: { io, env, cwd, fetchImpl }, out, err, fetchCalls };
}

/** The parsed `--json` envelope of a fund run. */
interface FundEnvelope {
  command: string;
  funded: boolean;
  network: string | null;
  faucetUrl?: string;
  results?: {
    chain: string;
    funded: boolean;
    address: string | null;
    response?: unknown;
    error?: string;
  }[];
  inferredDevnetFrom?: string;
  addresses?: { evm: string | null; solana: string | null; mina: string | null };
  guidance?: string;
  identity?: { source?: string };
}

function parseJson(h: Harness): FundEnvelope {
  return JSON.parse(h.out.join('\n')) as FundEnvelope;
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

  /**
   * Turn `cwd` into a real git repo whose `origin` remote is `url` — the same
   * state `rig remote add origin <url>` leaves behind. `rig fund` resolves
   * this origin the way push/fetch do, so a devnet origin should infer devnet
   * (#288) without any env var.
   */
  function gitOrigin(url: string): void {
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['remote', 'add', 'origin', url], { cwd });
  }

  const baseEnv = (): NodeJS.ProcessEnv => ({
    RIG_MNEMONIC: MNEMONIC,
    TOON_CLIENT_HOME: home,
  });

  // ── The all-chains default (#299 parity) ──────────────────────────────────

  it('default (no --chain) funds ALL three chains, native + USDC each', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--json'], h.deps)).toBe(0);

    // One POST per chain, in evm → solana → mina order.
    expect(h.fetchCalls.map((c) => c.url)).toEqual([
      `${DEVNET_FAUCET_URL}${EVM_PATH}`,
      `${DEVNET_FAUCET_URL}${SOLANA_PATH}`,
      `${DEVNET_FAUCET_URL}${MINA_PATH}`,
    ]);
    for (const call of h.fetchCalls) {
      expect(call.init?.method).toBe('POST');
      const body = JSON.parse(String(call.init?.body)) as { address: string };
      expect(Object.keys(body)).toEqual(['address']);
    }

    const parsed = parseJson(h);
    expect(parsed.command).toBe('fund');
    expect(parsed.funded).toBe(true);
    expect(parsed.network).toBe('devnet');
    expect(parsed.faucetUrl).toBe(DEVNET_FAUCET_URL);
    expect(parsed.results?.map((r) => r.chain)).toEqual(['evm', 'solana', 'mina']);
    expect(parsed.results?.every((r) => r.funded)).toBe(true);
    expect(parsed.results?.[0]?.response).toMatchObject({ success: true });
    expect(parsed.identity?.source).toBe('env');
  });

  it('--chain all is an explicit alias for the all-chains default', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--chain', 'all', '--json'], h.deps)).toBe(0);
    expect(h.fetchCalls).toHaveLength(3);
    expect(parseJson(h).results?.map((r) => r.chain)).toEqual([
      'evm',
      'solana',
      'mina',
    ]);
  });

  it('the drips run in PARALLEL, not serially (all three dispatched before any resolves)', async () => {
    writeConfig({ network: 'devnet' });
    // barrier: 3 ⇒ no faucet call resolves until all three have been
    // dispatched. Serial code would await the first and never reach the
    // barrier → the test times out; only concurrent drips complete.
    const h = makeHarness(baseEnv(), cwd, { barrier: 3 });
    expect(await runFund(['--json'], h.deps)).toBe(0);
    expect(h.fetchCalls).toHaveLength(3);
    expect(parseJson(h).funded).toBe(true);
  });

  it('the config `chain` field no longer narrows fund — default still funds all', async () => {
    writeConfig({ network: 'devnet', chain: 'solana' });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--json'], h.deps)).toBe(0);
    expect(h.fetchCalls).toHaveLength(3);
    expect(parseJson(h).results?.map((r) => r.chain)).toEqual([
      'evm',
      'solana',
      'mina',
    ]);
  });

  // ── Independent per-chain failure (the parallel-results contract) ──────────

  it('one chain failing does NOT abort the others — partial success, exit 1', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness(baseEnv(), cwd, {
      // Solana faucet is dry; evm + mina succeed.
      respond: (url) =>
        url.includes(SOLANA_PATH) ? { status: 503, body: 'faucet dry' } : undefined,
    });
    expect(await runFund(['--json'], h.deps)).toBe(1);

    const parsed = parseJson(h);
    expect(parsed.funded).toBe(false); // overall: not all funded
    const byChain = Object.fromEntries(
      (parsed.results ?? []).map((r) => [r.chain, r])
    );
    expect(byChain['evm']?.funded).toBe(true);
    expect(byChain['mina']?.funded).toBe(true);
    expect(byChain['solana']?.funded).toBe(false);
    expect(byChain['solana']?.error).toMatch(/503|faucet dry/);
    // All three were still attempted (independence, not fail-fast).
    expect(h.fetchCalls).toHaveLength(3);
  });

  it('partial-failure human output renders every chain and marks the failure', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness(baseEnv(), cwd, {
      respond: (url) =>
        url.includes(SOLANA_PATH) ? { status: 503, body: 'faucet dry' } : undefined,
    });
    expect(await runFund([], h.deps)).toBe(1);
    const text = h.out.join('\n');
    expect(text).toMatch(/evm\s+✓ funded \(ETH \+ USDC\)/);
    expect(text).toMatch(/mina\s+✓ funded \(MINA \+ USDC\)/);
    expect(text).toMatch(/solana\s+✗ .*(503|faucet dry)/);
  });

  // ── Single-chain targeting (preserved) ────────────────────────────────────

  it('--chain evm funds only evm and posts { address } with the derived 0x address', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--chain', 'evm', '--json'], h.deps)).toBe(0);

    expect(h.fetchCalls).toHaveLength(1);
    const call = h.fetchCalls[0] as Harness['fetchCalls'][0];
    expect(call.url).toBe(`${DEVNET_FAUCET_URL}${EVM_PATH}`);
    expect(call.init?.method).toBe('POST');
    const body = JSON.parse(String(call.init?.body)) as { address: string };
    expect(body.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const parsed = parseJson(h);
    expect(parsed.funded).toBe(true);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results?.[0]).toMatchObject({
      chain: 'evm',
      funded: true,
      address: body.address,
      response: { success: true },
    });
  });

  it('--chain solana uses the solana faucet path and a base58 address', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--chain', 'solana', '--json'], h.deps)).toBe(0);
    expect(h.fetchCalls).toHaveLength(1);
    const call = h.fetchCalls[0] as Harness['fetchCalls'][0];
    expect(call.url).toBe(`${DEVNET_FAUCET_URL}${SOLANA_PATH}`);
    const body = JSON.parse(String(call.init?.body)) as { address: string };
    expect(body.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('--address overrides the derived address (single --chain required)', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness(baseEnv(), cwd);
    expect(
      await runFund(['--chain', 'evm', '--address', '0x' + 'ab'.repeat(20)], h.deps)
    ).toBe(0);
    expect(h.fetchCalls).toHaveLength(1);
    const body = JSON.parse(String(h.fetchCalls[0]?.init?.body)) as {
      address: string;
    };
    expect(body.address).toBe('0x' + 'ab'.repeat(20));
  });

  it('--address without an explicit single --chain is a usage error (exit 2)', async () => {
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--address', '0x' + 'ab'.repeat(20)], h.deps)).toBe(2);
    expect(h.fetchCalls).toEqual([]);
    expect(h.err.join('\n')).toMatch(/--address requires an explicit single --chain/);
  });

  // ── Faucet-URL resolution ─────────────────────────────────────────────────

  it('an explicit TOON_CLIENT_FAUCET_URL wins over the devnet default', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness(
      { ...baseEnv(), TOON_CLIENT_FAUCET_URL: 'https://faucet.example' },
      cwd
    );
    expect(await runFund([], h.deps)).toBe(0);
    expect(h.fetchCalls).toHaveLength(3);
    expect(h.fetchCalls.every((c) => c.url.startsWith('https://faucet.example/'))).toBe(
      true
    );
    expect(h.fetchCalls[0]?.url).toBe(`https://faucet.example${EVM_PATH}`);
    expect(h.out.join('\n')).toMatch(/✓ funded/);
  });

  it('a configured faucetUrl enables funding regardless of network', async () => {
    writeConfig({ network: 'custom', faucetUrl: 'https://my-faucet.example' });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund([], h.deps)).toBe(0);
    expect(h.fetchCalls).toHaveLength(3);
    expect(h.fetchCalls[0]?.url).toBe(`https://my-faucet.example${EVM_PATH}`);
  });

  // ── No-faucet network: guidance + addresses, nothing fetched ──────────────

  it('non-devnet without a faucet prints funding guidance + addresses (exit 0, no fetch)', async () => {
    writeConfig({ network: 'testnet' });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--json'], h.deps)).toBe(0);
    expect(h.fetchCalls).toEqual([]);
    const parsed = parseJson(h);
    expect(parsed.funded).toBe(false);
    expect(parsed.network).toBe('testnet');
    expect(parsed.addresses?.evm).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(parsed.addresses?.solana).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(parsed.guidance).toMatch(/fund the wallet/i);
  });

  it('non-devnet human output lists the addresses per chain', async () => {
    writeConfig({}); // no network at all
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund([], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/no faucet is configured for network "custom"/);
    expect(text).toMatch(/evm\s+0x[0-9a-fA-F]{40}/);
    expect(text).toContain('Wallet addresses:');
  });

  // ── #280: the remediation must name the ACTUAL knob first ─────────────────

  it('custom network: TOON_CLIENT_NETWORK=devnet is suggested before TOON_CLIENT_FAUCET_URL', async () => {
    writeConfig({}); // fresh isolated home → network defaults to "custom"
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund([], h.deps)).toBe(0);
    expect(h.fetchCalls).toEqual([]);
    const text = h.out.join('\n');
    const networkKnob = text.indexOf('TOON_CLIENT_NETWORK=devnet');
    const faucetKnob = text.indexOf('TOON_CLIENT_FAUCET_URL');
    expect(networkKnob).toBeGreaterThanOrEqual(0);
    expect(faucetKnob).toBeGreaterThanOrEqual(0);
    expect(networkKnob).toBeLessThan(faucetKnob);
    // The faucet URL is framed as the SELF-HOSTED override, not the fix.
    expect(text).toMatch(/self-hosted[^.]*TOON_CLIENT_FAUCET_URL/);
  });

  it('a *.devnet.toonprotocol.dev relay on a "custom" network infers devnet and drips (#288)', async () => {
    writeConfig({
      network: 'custom',
      relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev',
    });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--json'], h.deps)).toBe(0);
    // Inferred devnet ⇒ the deployed faucet is hit for every chain.
    expect(h.fetchCalls).toHaveLength(3);
    expect(h.fetchCalls[0]?.url).toBe(`${DEVNET_FAUCET_URL}${EVM_PATH}`);
    const parsed = parseJson(h);
    expect(parsed.funded).toBe(true);
    expect(parsed.network).toBe('devnet');
    expect(parsed.faucetUrl).toBe(DEVNET_FAUCET_URL);
    expect(parsed.inferredDevnetFrom).toBe('wss://relay-ws.devnet.toonprotocol.dev');
  });

  it('a devnet-looking TOON_CLIENT_PROXY_URL env override infers devnet too (#288)', async () => {
    writeConfig({ network: 'custom' });
    const h = makeHarness(
      {
        ...baseEnv(),
        TOON_CLIENT_PROXY_URL: 'https://apex.devnet.toonprotocol.dev',
      },
      cwd
    );
    expect(await runFund([], h.deps)).toBe(0);
    expect(h.fetchCalls).toHaveLength(3);
    expect(h.fetchCalls[0]?.url).toBe(`${DEVNET_FAUCET_URL}${EVM_PATH}`);
    const text = h.out.join('\n');
    expect(text).toContain("Inferred network 'devnet' from the configured origin");
    expect(text).toContain('https://apex.devnet.toonprotocol.dev');
  });

  it('an explicit non-custom network is authoritative — a devnet origin does NOT override it (#288)', async () => {
    // testnet is a real choice; a devnet-looking relay must not coerce it to
    // devnet and silently drip from the wrong faucet.
    writeConfig({
      network: 'testnet',
      relayUrl: 'wss://relay-ws.devnet.toonprotocol.dev',
    });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--json'], h.deps)).toBe(0);
    expect(h.fetchCalls).toEqual([]);
    const parsed = parseJson(h);
    expect(parsed.funded).toBe(false);
    expect(parsed.network).toBe('testnet');
  });

  it('a non-devnet origin does NOT infer devnet (still prints guidance)', async () => {
    writeConfig({ relayUrl: 'wss://relay.example.com' });
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund([], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).not.toContain('looks like the shared devnet');
    expect(text).toContain('TOON_CLIENT_NETWORK=devnet');
  });

  // ── #288 reopened: infer devnet from the git `origin` remote too ──────────
  // The shipped #291 auto-detect only read env/config relay/proxy/btp URLs,
  // NOT the git remote `rig remote add origin …` writes. A fresh user who ran
  // only `rig remote add origin wss://…devnet…` still got network `custom`.

  it('a devnet git origin remote infers devnet and drips — no env var, no config network (#288)', async () => {
    writeConfig({}); // fresh config → network defaults to "custom"; no env relay
    gitOrigin('wss://relay-ws.devnet.toonprotocol.dev');
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund(['--json'], h.deps)).toBe(0);
    // The devnet origin alone drove drips from the deployed devnet faucet.
    expect(h.fetchCalls).toHaveLength(3);
    expect(h.fetchCalls[0]?.url).toBe(`${DEVNET_FAUCET_URL}${EVM_PATH}`);
    const parsed = parseJson(h);
    expect(parsed.funded).toBe(true);
    expect(parsed.network).toBe('devnet');
    expect(parsed.faucetUrl).toBe(DEVNET_FAUCET_URL);
    expect(parsed.inferredDevnetFrom).toBe(
      'wss://relay-ws.devnet.toonprotocol.dev'
    );
  });

  it('a devnet git origin: human output announces the inference (#288)', async () => {
    writeConfig({});
    gitOrigin('wss://relay-ws.devnet.toonprotocol.dev');
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund([], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain("Inferred network 'devnet' from the configured origin");
    expect(text).toContain('wss://relay-ws.devnet.toonprotocol.dev');
    expect(text).toMatch(/✓ funded/);
  });

  it('explicit TOON_CLIENT_NETWORK=testnet is authoritative over a devnet git origin (#288)', async () => {
    writeConfig({});
    gitOrigin('wss://relay-ws.devnet.toonprotocol.dev');
    const h = makeHarness({ ...baseEnv(), TOON_CLIENT_NETWORK: 'testnet' }, cwd);
    expect(await runFund(['--json'], h.deps)).toBe(0);
    expect(h.fetchCalls).toEqual([]);
    const parsed = parseJson(h);
    expect(parsed.funded).toBe(false);
    expect(parsed.network).toBe('testnet');
  });

  it('a non-devnet git origin does NOT infer devnet (unchanged guidance) (#288)', async () => {
    writeConfig({});
    gitOrigin('wss://relay.example.com');
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund([], h.deps)).toBe(0);
    expect(h.fetchCalls).toEqual([]);
    const text = h.out.join('\n');
    expect(text).not.toContain('looks like the shared devnet');
    expect(text).toContain('TOON_CLIENT_NETWORK=devnet');
  });

  it('a plain (non-relay) git origin is ignored — no crash, prints guidance (#288)', async () => {
    // An SSH GitHub clone URL is not a relay URL: resolveRelays skips it
    // (NoOriginConfiguredError), which fund swallows to "no origin relay".
    writeConfig({});
    gitOrigin('git@github.com:toon-protocol/toon-client.git');
    const h = makeHarness(baseEnv(), cwd);
    expect(await runFund([], h.deps)).toBe(0);
    expect(h.fetchCalls).toEqual([]);
    expect(h.out.join('\n')).toContain('no faucet is configured for network');
  });

  // ── Errors ────────────────────────────────────────────────────────────────

  it('a single --chain non-2xx faucet response is a per-chain failure (exit 1)', async () => {
    writeConfig({ network: 'devnet' });
    const h = makeHarness(baseEnv(), cwd, { status: 500, body: 'treasury empty' });
    expect(await runFund(['--chain', 'evm', '--json'], h.deps)).toBe(1);
    const parsed = parseJson(h);
    expect(parsed.command).toBe('fund');
    expect(parsed.funded).toBe(false);
    expect(parsed.results?.[0]?.funded).toBe(false);
    expect(parsed.results?.[0]?.error).toMatch(/500/);
    expect(parsed.results?.[0]?.error).toMatch(/treasury empty/);
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
