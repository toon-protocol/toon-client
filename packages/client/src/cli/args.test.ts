import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  UsageError,
  boolOption,
  listOption,
  parseCommandLine,
  stringOption,
  usage,
} from './args.js';
import { RUNNERS } from './commands/index.js';

describe('parseCommandLine', () => {
  it('reads the command and its positionals', () => {
    const line = parseCommandLine(['price', 'g.toon.store', 'https://node.example']);
    expect(line.command).toBe('price');
    expect(line.positionals).toEqual(['g.toon.store', 'https://node.example']);
  });

  it('reads global options wherever they appear', () => {
    const line = parseCommandLine(['--json', 'send', 'g.toon.store', '--connector', 'https://n']);
    expect(boolOption(line.values, 'json')).toBe(true);
    expect(stringOption(line.values, 'connector')).toBe('https://n');
  });

  it('keeps every -H in the order it was given, duplicates included', () => {
    const line = parseCommandLine([
      'send',
      'g.toon.store',
      '-H',
      'a: 1',
      '--header',
      'b:2',
      '-H',
      'a:3',
    ]);
    expect(listOption(line.values, 'header')).toEqual(['a: 1', 'b:2', 'a:3']);
  });

  it('refuses an unknown command', () => {
    expect(() => parseCommandLine(['nope'])).toThrow(UsageError);
  });

  it('refuses an unknown option', () => {
    expect(() => parseCommandLine(['balances', '--nope'])).toThrow(UsageError);
  });

  it("refuses an option that belongs to a different command", () => {
    expect(() => parseCommandLine(['balances', '--body', 'x'])).toThrow(
      /--body is not an option of 'balances'/
    );
  });

  it('refuses too few and too many positionals', () => {
    expect(() => parseCommandLine(['price'])).toThrow(/needs more arguments/);
    expect(() => parseCommandLine(['send', 'a', 'b'])).toThrow(/at most 1 argument/);
  });

  it('lets --help through without validating the rest', () => {
    const line = parseCommandLine(['price', '--help']);
    expect(line.command).toBe('price');
    expect(boolOption(line.values, 'help')).toBe(true);
  });

  it('returns no command for a bare invocation', () => {
    expect(parseCommandLine([]).command).toBeUndefined();
  });
});

describe('usage', () => {
  it('lists every command', () => {
    const text = usage();
    for (const name of Object.keys(COMMANDS)) expect(text).toContain(name);
  });

  it('documents a command’s own options and the globals', () => {
    const text = usage('send');
    expect(text).toContain('-H, --header');
    expect(text).toContain('--json-body');
    expect(text).toContain('--connector');
  });
});

describe('the command table', () => {
  // Documented-but-undispatchable and dispatchable-but-undocumented are both
  // bugs that no other test would catch: `help` is the one command main.ts
  // answers itself, so it is the only permitted difference.
  it('agrees with the runner table', () => {
    const documented = Object.keys(COMMANDS).filter((name) => name !== 'help').sort();
    expect(Object.keys(RUNNERS).sort()).toEqual(documented);
  });
});
