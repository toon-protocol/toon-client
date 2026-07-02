/**
 * `calmBootstrapNoise` tests (#280): the embedded client's core `console.warn`s
 * `[Bootstrap] Announce failed …: … (402 Payment Required): {…x402…}` straight
 * to stderr on every paid command run by a fresh/unfunded identity. That is
 * EXPECTED pre-payment behavior, but a first-run user reads it as their
 * (succeeding) push having failed. The process-level stderr calmer reframes
 * the first 402-announce line as one plain-language info line, drops repeats,
 * and passes every other write through untouched — including announce
 * failures that are NOT the expected 402 (those are real signal).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  ANNOUNCE_402_INFO,
  calmBootstrapNoise,
  redirectStdoutToStderr,
  type StderrCalmer,
  type StdoutGuard,
} from './output.js';

/** The real study line: announce refusal with the x402 challenge JSON dump. */
const ANNOUNCE_402_LINE =
  '[Bootstrap] Announce failed for nostr-2813187eb66741f9: ILP-over-HTTP ' +
  'request rejected (402 Payment Required): {"x402Version":1,"accepts":[{"scheme":"exact"}]}\n';

describe('calmBootstrapNoise (#280)', () => {
  const written: string[] = [];
  let calmer: StderrCalmer | undefined;
  let stdoutGuard: StdoutGuard | undefined;
  let realStderrWrite: typeof process.stderr.write;

  /** Capture what ultimately reaches stderr, then install the calmer. */
  function install(): void {
    realStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: Uint8Array | string): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    calmer = calmBootstrapNoise();
  }

  afterEach(() => {
    stdoutGuard?.restore();
    stdoutGuard = undefined;
    calmer?.restore();
    calmer = undefined;
    process.stderr.write = realStderrWrite;
    written.length = 0;
  });

  it('reframes the announce-402 dump as one calm plain-language line', () => {
    install();
    process.stderr.write(ANNOUNCE_402_LINE);
    expect(written).toEqual([ANNOUNCE_402_INFO]);
    // The reframe explains itself: no x402 JSON, no HTTP status jargon left,
    // and it says the failure is expected + harmless.
    expect(ANNOUNCE_402_INFO).not.toContain('402');
    expect(ANNOUNCE_402_INFO).toMatch(/harmless/);
    expect(ANNOUNCE_402_INFO).toMatch(/expected/);
  });

  it('drops repeat announce-402 lines (one calm line per process, not per peer)', () => {
    install();
    process.stderr.write(ANNOUNCE_402_LINE);
    process.stderr.write(
      '[Bootstrap] Announce failed for nostr-ffffffffffffffff: ILP-over-HTTP ' +
        'request rejected (402 Payment Required): {"x402Version":1}\n'
    );
    expect(written.join('')).toBe(ANNOUNCE_402_INFO);
  });

  it('passes non-402 announce failures through untouched — those are signal', () => {
    install();
    const line =
      '[Bootstrap] Announce failed for nostr-2813187eb66741f9: fetch failed (ECONNREFUSED)\n';
    process.stderr.write(line);
    expect(written).toEqual([line]);
  });

  it('passes unrelated stderr writes through untouched', () => {
    install();
    process.stderr.write('[Bootstrap] Successfully bootstrapped with abcd1234...\n');
    process.stderr.write('rig: some warning\n');
    expect(written).toEqual([
      '[Bootstrap] Successfully bootstrapped with abcd1234...\n',
      'rig: some warning\n',
    ]);
  });

  it('composes with the --json stdout guard: rerouted stdout noise is calmed too', () => {
    install();
    // The #265 guard reroutes process.stdout.write → process.stderr.write via
    // a dynamic lookup, so it must hit the calmer regardless of patch order.
    const stdoutSink: string[] = [];
    stdoutGuard = redirectStdoutToStderr((text) => {
      stdoutSink.push(text);
    });
    process.stdout.write(ANNOUNCE_402_LINE);
    expect(written).toEqual([ANNOUNCE_402_INFO]);
    expect(stdoutSink).toEqual([]); // nothing leaked to the machine stream
  });

  it('restore() undoes the patch', () => {
    install();
    calmer?.restore();
    calmer = undefined;
    process.stderr.write(ANNOUNCE_402_LINE);
    expect(written).toEqual([ANNOUNCE_402_LINE]);
  });
});
