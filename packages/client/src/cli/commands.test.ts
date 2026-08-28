/**
 * Every command, driven through {@link runCli} exactly as a shell would, against
 * a fake client. What is under test is the CLI's own contract: which client
 * method a command calls and with what, what it prints, and what it exits with.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT, exitCodeFor, runCli } from './main.js';
import {
  FakeToonClient,
  fakeChannelState,
  fakeFulfilled,
  fakeRefused,
  type FakeClientOptions,
} from './fake-client.test-support.js';
import type { ToonClientConfig } from '../client/types.js';
import { ChannelFundingError, NetworkError, ValidationError } from '../client/errors.js';

const PHRASE = 'test test test test test test test test test test test junk';

interface RunOptions {
  client?: FakeClientOptions;
  env?: Record<string, string | undefined>;
  stdin?: string;
  files?: Record<string, string>;
}

interface RunResult {
  code: number;
  stdout: string[];
  stderr: string[];
  client: FakeToonClient;
  config: ToonClientConfig | undefined;
  /** stdout parsed, for `--json` runs. */
  json: () => unknown;
}

async function run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const client = new FakeToonClient(options.client);
  let config: ToonClientConfig | undefined;

  const code = await runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    deps: {
      env: {
        TOON_MNEMONIC: PHRASE,
        TOON_CONNECTOR: 'https://node.example',
        ...options.env,
      },
      home: '/home/x',
      readFile: (path: string) => {
        const file = options.files?.[path];
        if (file === undefined) throw new Error(`no such file ${path}`);
        return file;
      },
      readFileBytes: (path: string) => {
        const file = options.files?.[path];
        if (file === undefined) throw new Error(`no such file ${path}`);
        return new TextEncoder().encode(file);
      },
      readStdin: async () => new TextEncoder().encode(options.stdin ?? ''),
      createClient: async (given) => {
        config = given;
        return client;
      },
    },
  });

  return {
    code,
    stdout,
    stderr,
    client,
    config,
    json: () => JSON.parse(stdout.join('\n')) as unknown,
  };
}

describe('describe', () => {
  it('prints the node’s routes with both the base units and the human figure', async () => {
    const result = await run(['describe']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout.join('\n')).toContain('1000 (0.001 USDC)');
    expect(result.stdout.join('\n')).toContain('g.toon.store');
  });

  it('runs with no keys at all', async () => {
    const result = await run(['describe'], { env: { TOON_MNEMONIC: undefined } });
    expect(result.code).toBe(EXIT.ok);
    expect(result.config?.mnemonic).toBeUndefined();
    expect(result.config?.evmPrivateKey).toBeInstanceOf(Uint8Array);
  });

  it('lets its own URL argument outrank every other source, silently', async () => {
    const result = await run(['describe', 'https://other.example'], {
      env: { TOON_CONNECTOR: undefined },
    });
    expect(result.config?.connector).toBe('https://other.example');
    expect(result.stderr.join('\n')).not.toMatch(/no connector given/);
  });

  it.each(['identity', 'init'])(
    'says nothing about a connector for %s, which never reaches one',
    async (command) => {
      const result = await run([command, '--help'], {
        env: { TOON_CONNECTOR: undefined },
      });
      expect(result.stderr.join('\n')).not.toMatch(/no connector given/);
    }
  );

  it('warns on stderr when it falls back to the devnet preset', async () => {
    const result = await run(['describe'], { env: { TOON_CONNECTOR: undefined } });
    expect(result.stderr.join('\n')).toMatch(/no connector given/);
    expect(result.code).toBe(EXIT.ok);
  });

  it('emits one JSON document under --json', async () => {
    const result = await run(['describe', '--json']);
    const doc = result.json() as { routes: { price: string }[] };
    expect(doc.routes[0]?.price).toBe('1000');
  });
});

describe('price', () => {
  it('prints the price', async () => {
    const result = await run(['price', 'g.toon.store']);
    expect(result.client.callsTo('routePrice')[0]?.args).toEqual(['g.toon.store']);
    expect(result.stdout.join('\n')).toContain('1000 (0.001 USDC)');
  });

  it('prints the per-KiB rate beside the base price on a metered route', async () => {
    // A metered route's base price is never what a packet costs, so `toon price`
    // has to say so rather than leaving a caller to discover it via `F03`.
    const result = await run(['price', 'g.toon.store'], { client: { pricePerKib: 10n } });
    const out = result.stdout.join('\n');
    expect(out).toContain('1000 (0.001 USDC)');
    expect(out).toContain('/KiB');
  });

  it('treats "no route" as an answer, not a failure', async () => {
    const result = await run(['price', 'g.somewhere.else'], { client: { price: null } });
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout.join('\n')).toMatch(/no route/);
  });

  it('takes a connector URL as its second argument', async () => {
    const result = await run(['price', 'g.toon.store', 'https://other.example']);
    expect(result.config?.connector).toBe('https://other.example');
  });
});

describe('probe', () => {
  it('reports the cost the connector charged for the path and exits 0', async () => {
    const result = await run(['probe', 'g.toon.store']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout.join('\n')).toContain('1000 (0.001 USDC)');
    expect(result.stdout.join('\n')).toContain('F03');
  });
});

describe('send', () => {
  it('prints the app’s answer and exits 0', async () => {
    const result = await run(['send', 'g.toon.store', '--body', 'hi']);
    expect(result.code).toBe(EXIT.ok);
    const text = result.stdout.join('\n');
    expect(text).toContain('FULFILL 200');
    expect(text).toContain('content-type:');
    expect(text).toContain('hello');
  });

  it('passes method, target and the body through', async () => {
    const result = await run([
      'send',
      'g.toon.store',
      '--method',
      'GET',
      '--target',
      'objects/1',
      '--body',
      'hi',
    ]);
    expect(result.client.callsTo('send')[0]?.args[1]).toEqual({
      method: 'GET',
      target: 'objects/1',
      body: 'hi',
    });
  });

  it('keeps every -H in order, duplicates included', async () => {
    const result = await run([
      'send',
      'g.toon.store',
      '-H',
      'x-a: 1',
      '-H',
      'x-b:2',
      '-H',
      'x-a:3',
    ]);
    const request = result.client.callsTo('send')[0]?.args[1] as { headers: [string, string][] };
    expect(request.headers).toEqual([
      ['x-a', '1'],
      ['x-b', '2'],
      ['x-a', '3'],
    ]);
  });

  it('refuses a header that is not name:value', async () => {
    const result = await run(['send', 'g.toon.store', '-H', 'nonsense']);
    expect(result.code).toBe(EXIT.usage);
  });

  it('reads the body from a file', async () => {
    const result = await run(['send', 'g.toon.store', '--body-file', '/payload.bin'], {
      files: { '/payload.bin': 'from-file' },
    });
    const request = result.client.callsTo('send')[0]?.args[1] as { body: Uint8Array };
    expect(new TextDecoder().decode(request.body)).toBe('from-file');
  });

  it('reads the body from stdin when it is `-`', async () => {
    const result = await run(['send', 'g.toon.store', '--body', '-'], { stdin: 'from-stdin' });
    const request = result.client.callsTo('send')[0]?.args[1] as { body: Uint8Array };
    expect(new TextDecoder().decode(request.body)).toBe('from-stdin');
  });

  it('refuses two body sources at once', async () => {
    const result = await run([
      'send',
      'g.toon.store',
      '--body',
      'a',
      '--body-file',
      '/payload.bin',
    ]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr.join('\n')).toMatch(/not both/);
  });

  it('adds a content type for --json-body, and forwards the exact bytes', async () => {
    const result = await run([
      'send',
      'g.toon.store',
      '--json-body',
      '--body',
      '{ "a" :  1 }',
    ]);
    const request = result.client.callsTo('send')[0]?.args[1] as {
      headers: [string, string][];
      body: string;
    };
    expect(request.headers).toEqual([['content-type', 'application/json']]);
    expect(request.body).toBe('{ "a" :  1 }');
  });

  it('does not overwrite a content type the user set themselves', async () => {
    const result = await run([
      'send',
      'g.toon.store',
      '--json-body',
      '-H',
      'content-type: application/ld+json',
      '--body',
      '{}',
    ]);
    const request = result.client.callsTo('send')[0]?.args[1] as { headers: [string, string][] };
    expect(request.headers).toEqual([['content-type', 'application/ld+json']]);
  });

  it('refuses --json-body that is not JSON, before anything is paid', async () => {
    const result = await run(['send', 'g.toon.store', '--json-body', '--body', 'not json']);
    expect(result.code).toBe(EXIT.usage);
    expect(result.client.callsTo('send')).toHaveLength(0);
  });

  it('passes --amount through as a bigint', async () => {
    const result = await run(['send', 'g.toon.store', '--amount', '2500']);
    expect(result.client.callsTo('send')[0]?.args[2]).toEqual({ amount: 2500n });
  });

  it('prints a refusal in full and exits 3', async () => {
    const result = await run(['send', 'g.toon.store'], { client: { send: fakeRefused() } });
    expect(result.code).toBe(EXIT.refused);
    const text = result.stdout.join('\n');
    expect(text).toContain('REFUSED F03');
    expect(text).toContain('1000 (0.001 USDC)');
    expect(text).toMatch(/toon channel deposit/);
  });

  it('tells you which carriage to retry over when the route insists on one', async () => {
    const refusal = fakeRefused({
      code: 'PAYMENT_REQUIRED',
      refusedBy: 'edge',
      accumulatedCost: undefined,
      terms: {
        destination: 'g.toon.relay',
        price: 1n,
        requiredTransport: 'btp',
        settlements: [],
        raw: {},
      },
    });
    const result = await run(['send', 'g.toon.relay'], { client: { send: refusal } });
    expect(result.code).toBe(EXIT.refused);
    expect(result.stdout.join('\n')).toMatch(/--transport btp/);
  });

  it('emits one JSON document, bytes base64 and amounts as strings', async () => {
    const result = await run(['send', 'g.toon.store', '--json']);
    const doc = result.json() as {
      body: string;
      text: string;
      claim: { amount: string };
      fulfillment: string;
    };
    expect(doc.body).toBe(Buffer.from('hello').toString('base64'));
    expect(doc.text).toBe('hello');
    expect(doc.claim.amount).toBe('1000');
    expect(result.stdout).toHaveLength(1);
  });

  it('reports a binary body by size rather than mangling it', async () => {
    const binary = fakeFulfilled({ body: new Uint8Array([0xff, 0xfe, 0x00]) } as never);
    const result = await run(['send', 'g.toon.store'], { client: { send: binary } });
    expect(result.stdout.join('\n')).toMatch(/3 bytes of binary/);
  });
});

describe('channel', () => {
  it('opens with a deposit', async () => {
    const result = await run(['channel', 'open', '--deposit', '100000']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.client.callsTo('channel.open')[0]?.args[0]).toEqual({ deposit: '100000' });
    expect(result.stdout.join('\n')).toContain('100000 (0.1 USDC)');
  });

  it('deposits the amount given as a positional', async () => {
    const result = await run(['channel', 'deposit', '50000']);
    expect(result.client.callsTo('channel.deposit')[0]?.args[0]).toBe('50000');
  });

  it('closes and settles', async () => {
    expect((await run(['channel', 'close'])).client.callsTo('channel.close')).toHaveLength(1);
    expect((await run(['channel', 'settle'])).client.callsTo('channel.settle')).toHaveLength(1);
  });

  it('reads the on-chain state for status', async () => {
    const result = await run(['channel', 'status']);
    expect(result.client.callsTo('channel.state')[0]?.args[0]).toEqual({ onChain: true });
    expect(result.stdout.join('\n')).toContain('97000 (0.097 USDC)');
  });

  it('shows the connector’s own watermark beside ours when asked', async () => {
    const result = await run(['channel', 'status', '--connector-view']);
    expect(result.client.callsTo('claimState')[0]?.args[0]).toEqual(['0xchannel']);
    expect(result.stdout.join('\n')).toMatch(/connector nonce\s+4/);
  });

  it('refuses an unknown subcommand', async () => {
    const result = await run(['channel', 'frobnicate']);
    expect(result.code).toBe(EXIT.usage);
  });

  it('renders a channel that has been closed', async () => {
    const state = fakeChannelState({
      status: 'closed',
      onChain: { closedAt: 1_700_000_000n, settleableAt: 1_700_003_600n },
    });
    const result = await run(['channel', 'status'], { client: { channelState: state } });
    expect(result.stdout.join('\n')).toContain('settleable at');
  });
});

describe('claim-state, balances, transfer, faucet', () => {
  it('prints the connector’s watermark', async () => {
    const result = await run(['claim-state']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout.join('\n')).toContain('4000 (0.004 USDC)');
  });

  it('says so plainly when the connector knows of no channel', async () => {
    const result = await run(['claim-state'], { client: { claimState: [] } });
    expect(result.stdout.join('\n')).toMatch(/toon channel open/);
  });

  it('prints balances, and marks an unreadable chain as unreadable', async () => {
    const result = await run(['balances'], {
      client: {
        balances: [
          {
            chain: 'evm',
            chainKey: 'evm:84532',
            address: '0xabc',
            native: { symbol: 'ETH', amount: '1000000000000000', decimals: 18 },
            tokens: [{ symbol: 'USDC', amount: '100000', decimals: 6 }],
          },
          { chain: 'solana', chainKey: 'solana', address: 'Sol', tokens: [], unreadable: true },
        ],
      },
    });
    const text = result.stdout.join('\n');
    expect(text).toContain('100000 (0.1 USDC)');
    expect(text).toContain('unreadable');
  });

  it('transfers, defaulting the asset to the settlement token', async () => {
    const result = await run(['transfer', '--to', '0xdest', '--amount', '5000']);
    expect(result.client.callsTo('wallet.transfer')[0]?.args[0]).toEqual({
      chain: 'evm',
      asset: 'token',
      to: '0xdest',
      amount: '5000',
    });
  });

  it('refuses a transfer with no destination', async () => {
    const result = await run(['transfer', '--amount', '5000']);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr.join('\n')).toMatch(/--to/);
  });

  it('asks the faucet', async () => {
    const result = await run(['faucet']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.client.callsTo('wallet.faucet')).toHaveLength(1);
  });
});

describe('identity', () => {
  it('derives locally and never builds a client', async () => {
    const result = await run(['identity']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.config).toBeUndefined();
    expect(result.stdout.join('\n')).toContain("m/44'/60'/0'/0/0");
  });

  it('shows both derivations, so a pre-1.0 address can be found', async () => {
    const result = await run(['identity', '--all-derivations', '--json']);
    const doc = result.json() as { derivations: { scheme: string; evmAddress: string }[] };
    expect(doc.derivations.map((d) => d.scheme)).toEqual(['standard', 'legacy']);
    expect(doc.derivations[0]?.evmAddress).not.toBe(doc.derivations[1]?.evmAddress);
  });

  it("says to run 'toon init' when there are no keys", async () => {
    const result = await run(['identity'], { env: { TOON_MNEMONIC: undefined } });
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr.join('\n')).toMatch(/toon init/);
  });
});

describe('init', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'toon-cli-init-'));
  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('creates a keystore, shows the phrase once, and refuses to do it twice', async () => {
    const path = join(workspace, 'keystore.json');
    const first = await run(['init', '--keystore', path], {
      env: { TOON_KEYSTORE_PASSWORD: 'pw', TOON_MNEMONIC: undefined },
    });
    expect(first.code).toBe(EXIT.ok);
    expect(first.stdout.join('\n')).toMatch(/recovery phrase/);
    expect(first.stdout.join('\n')).toMatch(/toon channel open/);

    const second = await run(['init', '--keystore', path], {
      env: { TOON_KEYSTORE_PASSWORD: 'pw', TOON_MNEMONIC: undefined },
    });
    expect(second.code).toBe(EXIT.usage);
    expect(second.stderr.join('\n')).toMatch(/already exists/);
  });

  it('imports a phrase from stdin, never from an argument', async () => {
    const path = join(workspace, 'imported.json');
    const result = await run(['init', '--import', '--keystore', path, '--json'], {
      env: { TOON_KEYSTORE_PASSWORD: 'pw', TOON_MNEMONIC: undefined },
      stdin: `${PHRASE}\n`,
    });
    expect(result.code).toBe(EXIT.ok);
    const doc = result.json() as { evmAddress: string; mnemonic?: string; derivation: string };
    expect(doc.derivation).toBe('standard');
    // An imported phrase is not echoed back: the user already has it.
    expect(doc.mnemonic).toBeUndefined();
    // The keystore is now the key source, so identity finds the same address.
    const identity = await run(['identity', '--keystore', path, '--json'], {
      env: { TOON_KEYSTORE_PASSWORD: 'pw', TOON_MNEMONIC: undefined },
    });
    expect((identity.json() as { evmAddress: string }).evmAddress).toBe(doc.evmAddress);
  });

  it('records the legacy derivation when asked, so old channels stay reachable', async () => {
    const path = join(workspace, 'legacy.json');
    const result = await run(
      ['init', '--import', '--legacy-derivation', '--keystore', path, '--json'],
      {
        env: { TOON_KEYSTORE_PASSWORD: 'pw', TOON_MNEMONIC: undefined },
        stdin: PHRASE,
      }
    );
    const doc = result.json() as { derivation: string; evmPath: string };
    expect(doc.derivation).toBe('legacy');
    expect(doc.evmPath).toBe("m/44'/1237'/0'/0/0");
  });

  it('refuses a phrase that is not BIP-39', async () => {
    const result = await run(['init', '--import', '--keystore', join(workspace, 'bad.json')], {
      env: { TOON_KEYSTORE_PASSWORD: 'pw', TOON_MNEMONIC: undefined },
      stdin: 'not a mnemonic',
    });
    expect(result.code).toBe(EXIT.usage);
  });
});

describe('help and version', () => {
  it('prints the command list for a bare invocation', async () => {
    const result = await run([]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout.join('\n')).toContain('toon <command>');
  });

  it('prints one command in detail', async () => {
    const result = await run(['help', 'send']);
    expect(result.stdout.join('\n')).toContain('-H, --header');
  });

  it('answers --help for a command without running it', async () => {
    const result = await run(['send', 'g.toon.store', '--help']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.client.callsTo('send')).toHaveLength(0);
  });

  it('prints the package version', async () => {
    const result = await run(['--version']);
    expect(result.stdout.join('\n')).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('exit codes', () => {
  const cases: [string, unknown, number][] = [
    ['a network failure', new NetworkError('unreachable'), EXIT.network],
    ['an unfunded channel open', new ChannelFundingError('no gas'), EXIT.funding],
    ['bad input', new ValidationError('nope'), EXIT.usage],
    [
      'a payment greeting',
      Object.assign(new Error('terms'), { code: 'PAYMENT_REQUIRED' }),
      EXIT.paymentRequired,
    ],
    [
      'a required carriage',
      Object.assign(new Error('btp only'), { code: 'TRANSPORT_REQUIRED' }),
      EXIT.paymentRequired,
    ],
    [
      'no channel yet',
      Object.assign(new Error('open one'), { code: 'CHANNEL_NOT_OPEN' }),
      EXIT.funding,
    ],
    ['something nobody named', new Error('boom'), EXIT.unexpected],
  ];

  for (const [name, error, expected] of cases) {
    it(`maps ${name} to ${String(expected)}`, async () => {
      const result = await run(['send', 'g.toon.store'], { client: { throws: { method: 'send', error } } });
      expect(result.code).toBe(expected);
    });
  }

  it('reads a refused socket out of fetch’s nested cause', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(exitCodeFor(new TypeError('fetch failed', { cause }))).toBe(EXIT.network);
  });

  it('closes the client even when the command threw', async () => {
    const result = await run(['send', 'g.toon.store'], {
      client: { throws: { method: 'send', error: new Error('boom') } },
    });
    expect(result.code).toBe(EXIT.unexpected);
    expect(result.client.closed).toBe(true);
  });

  it('closes the client after a successful command', async () => {
    const result = await run(['send', 'g.toon.store']);
    expect(result.client.closed).toBe(true);
  });
});
