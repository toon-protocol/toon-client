import { describe, expect, it } from 'vitest';
import {
  Output,
  assetFromSettlement,
  assetSymbol,
  columns,
  decodeUtf8,
  formatAmount,
  toJsonValue,
} from './output.js';
import { FAKE_SETTLEMENT } from './fake-client.test-support.js';

describe('formatAmount', () => {
  it('shows base units and the human figure side by side', () => {
    expect(formatAmount(1000n, { decimals: 6, symbol: 'USDC' })).toBe('1000 (0.001 USDC)');
  });

  it('drops the symbol when nothing names the asset', () => {
    expect(formatAmount(1000n, { decimals: 6 })).toBe('1000 (0.001)');
  });

  it('prints base units alone rather than guessing a decimal point', () => {
    expect(formatAmount(1000n)).toBe('1000');
  });

  it('accepts the decimal strings the connector uses for money', () => {
    expect(formatAmount('100000', { decimals: 6, symbol: 'USDC' })).toBe('100000 (0.1 USDC)');
  });

  it('does not round a value past 2^53', () => {
    const huge = 9_007_199_254_740_993n;
    expect(formatAmount(huge)).toBe('9007199254740993');
  });
});

describe('asset labelling', () => {
  it('names the devnet mock USDC on either chain', () => {
    expect(assetSymbol(FAKE_SETTLEMENT.tokenAddress)).toBe('USDC');
    expect(assetSymbol('0xdeadbeef')).toBeUndefined();
  });

  it('takes decimals from the connector’s own settlement entry', () => {
    expect(assetFromSettlement(FAKE_SETTLEMENT)).toEqual({ decimals: 6, symbol: 'USDC' });
    expect(assetFromSettlement(undefined)).toEqual({});
  });
});

describe('toJsonValue', () => {
  it('turns a bigint into a decimal string, never a number', () => {
    expect(toJsonValue({ price: 1000n })).toEqual({ price: '1000' });
  });

  it('base64s bytes', () => {
    expect(toJsonValue(new Uint8Array([104, 105]))).toBe('aGk=');
  });

  it('drops functions, so a result’s helpers cannot leak in as null', () => {
    expect(toJsonValue({ text: () => 'hi', status: 200 })).toEqual({ status: 200 });
  });

  it('recurses through arrays and objects', () => {
    expect(toJsonValue({ claims: [{ amount: 5n }] })).toEqual({ claims: [{ amount: '5' }] });
  });
});

describe('decodeUtf8', () => {
  it('decodes text', () => {
    expect(decodeUtf8(new TextEncoder().encode('héllo'))).toBe('héllo');
  });

  it('refuses bytes that are not UTF-8 rather than mangling them', () => {
    expect(decodeUtf8(new Uint8Array([0xff, 0xfe, 0x00]))).toBeUndefined();
  });
});

describe('columns', () => {
  it('pads the left column to a common width', () => {
    expect(columns([['a', '1'], ['long', '2']])).toBe('a     1\nlong  2');
  });
});

describe('the --json contract', () => {
  function capture(json: boolean) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      output: new Output({ json, stdout: (t) => out.push(t), stderr: (t) => err.push(t) }),
    };
  }

  it('puts exactly one JSON document on stdout and nothing else', () => {
    const { out, err, output } = capture(true);
    output.warn('a warning');
    output.line('a human line');
    output.render({ price: 1000n }, () => {
      output.line('never printed');
    });
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] as string)).toEqual({ price: '1000' });
    expect(err).toEqual(['a warning']);
  });

  it('renders for a person when --json is off', () => {
    const { out, output } = capture(false);
    output.render({ price: 1000n }, () => {
      output.line('price 1000');
    });
    expect(out).toEqual(['price 1000']);
  });

  it('refuses to emit a second document', () => {
    const { output } = capture(true);
    output.render({}, () => undefined);
    expect(() => {
      output.render({}, () => undefined);
    }).toThrow(/exactly one document/);
  });

  it('suppresses warnings under --quiet but never errors', () => {
    const err: string[] = [];
    const output = new Output({ quiet: true, stderr: (t) => err.push(t) });
    output.warn('hidden');
    output.error('shown');
    expect(err).toEqual(['shown']);
  });
});
