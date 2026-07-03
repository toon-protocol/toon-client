/**
 * The rig CLI output layer (#265): the strict `--json` stdout guarantee.
 *
 * CONTRACT — when `--json` is set on a rig-owned command, stdout carries
 * EXACTLY ONE parseable JSON document and nothing else. Agents consume this
 * stream (`rig … --json | jq`), so any stray banner, progress line, warning,
 * deprecation nudge, or third-party `console.log` on stdout breaks pipelines
 * (the #260 addendum: `[Bootstrap] …` logs from the embedded client's core
 * polluted `rig push --json`). Everything human-facing goes to stderr.
 *
 * Three layers enforce the contract (composed in ./rig.ts; the enforcement
 * matrix in ./strict-json.test.ts mirrors that composition):
 *
 *   1. {@link makeCliIo} — the ONLY output surface commands use. In JSON mode
 *      `out()` (human lines) reroutes to stderr and `emitJson()` is the sole
 *      writer that reaches the real stdout.
 *   2. {@link redirectStdoutToStderr} — a process-level guard for code the io
 *      seam cannot reach: dependencies that `console.log` directly (the
 *      embedded `@toon-protocol/client`'s core bootstrap does). Installed
 *      before any command code runs, it reroutes EVERY `process.stdout.write`
 *      to stderr; only the writer it returns (wired into `emitJson`) still
 *      reaches the real stdout.
 *   3. {@link RigIo.ensureSingleJsonDoc} — the backstop for paths that bail
 *      out before emitting an envelope (usage errors, pre-payment refusals):
 *      after dispatch it emits one error envelope built from the collected
 *      stderr lines, so stdout is never empty in JSON mode.
 *
 * GIT PASSTHROUGH IS EXEMPT: `--json` is a per-subcommand flag on rig-owned
 * verbs, not a global rig flag. Any verb rig does not own goes to system git
 * with the EXACT argv tail and inherited stdio — `rig status --json` runs
 * `git status --json` (git rejects it), and flags BEFORE the subcommand
 * (`rig --json status`) are not rig's either: the whole argv passes through
 * to git verbatim. {@link isJsonInvocation} implements exactly that boundary.
 */

// ---------------------------------------------------------------------------
// The io seam
// ---------------------------------------------------------------------------

/** Terminal I/O seam — every rig-owned command writes ONLY through this. */
export interface CliIo {
  /**
   * One HUMAN-facing line: stdout normally, stderr when `--json` is active
   * (chatter must never pollute the machine stream).
   */
  out(line: string): void;
  /** One human-facing line to stderr (warnings, nudges, errors). */
  err(line: string): void;
  /**
   * THE machine-readable JSON document of a `--json` run — serialized here
   * (2-space indent) and written to the REAL stdout. Must be a command's
   * single stdout emission; call it at most once per invocation.
   */
  emitJson(payload: unknown): void;
  /** True when stdin+stdout are TTYs (interactive confirm possible). */
  isInteractive: boolean;
  /** Ask a y/N question; resolves true on explicit yes. */
  confirm(question: string): Promise<boolean>;
}

/** {@link CliIo} plus the JSON-mode bookkeeping the entrypoint needs. */
export interface RigIo extends CliIo {
  /** True when this invocation runs in `--json` mode. */
  readonly jsonMode: boolean;
  /** True once `emitJson` has written the machine document. */
  readonly emittedJson: boolean;
  /**
   * The #265 backstop: called once after dispatch (see ./rig.ts). In JSON
   * mode, when NO machine document was emitted (usage error, pre-payment
   * refusal, unexpected crash), emits one error envelope carrying the
   * human-facing lines the run wrote to stderr — so `--json` stdout always
   * parses. No-op outside JSON mode or after a real emission.
   */
  ensureSingleJsonDoc(exitCode: number): void;
}

/** Sinks + terminal facts {@link makeCliIo} builds a {@link RigIo} from. */
export interface CliIoOptions {
  /** Whether this invocation is a rig-owned command with `--json`. */
  jsonMode: boolean;
  /**
   * Write to the REAL stdout (in JSON mode: the pre-guard writer returned by
   * {@link redirectStdoutToStderr}). Receives full text including newlines.
   */
  writeStdout(text: string): void;
  /** Write to stderr. Receives full text including newlines. */
  writeStderr(text: string): void;
  isInteractive: boolean;
  confirm(question: string): Promise<boolean>;
}

/**
 * Build the {@link RigIo} for one invocation. Centralizes the #265 routing:
 * human lines → stderr in JSON mode, and `emitJson` as the only stdout path.
 */
export function makeCliIo(options: CliIoOptions): RigIo {
  const { jsonMode, writeStdout, writeStderr } = options;
  let emittedJson = false;
  /** Human lines collected in JSON mode — the backstop envelope's detail. */
  const humanLines: string[] = [];

  const toStderr = (line: string): void => {
    if (jsonMode) humanLines.push(line);
    writeStderr(`${line}\n`);
  };

  return {
    jsonMode,
    get emittedJson() {
      return emittedJson;
    },
    out: (line) => {
      if (jsonMode) {
        toStderr(line);
      } else {
        writeStdout(`${line}\n`);
      }
    },
    err: toStderr,
    emitJson: (payload) => {
      emittedJson = true;
      writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
    },
    isInteractive: options.isInteractive,
    confirm: options.confirm,
    ensureSingleJsonDoc(exitCode: number): void {
      if (!jsonMode || emittedJson) return;
      const detail =
        humanLines.join('\n') ||
        (exitCode === 0
          ? 'the command produced no machine output'
          : 'the command failed before emitting machine output — see stderr');
      this.emitJson(
        exitCode === 0
          ? { error: null, exitCode, detail }
          : { error: 'error', exitCode, detail }
      );
    },
  };
}

// ---------------------------------------------------------------------------
// JSON-mode detection (and the git-passthrough exemption)
// ---------------------------------------------------------------------------

/**
 * The verbs rig owns — everything else is `git <argv…>` verbatim. Must match
 * the ./dispatch.ts switch (dispatch.test.ts pins both directions).
 */
export const RIG_OWNED_VERBS: ReadonlySet<string> = new Set([
  'init',
  'remote',
  'clone',
  'fetch',
  'push',
  'issue',
  'comment',
  'pr',
  'maintainers',
  'channel',
  'fund',
  'balance',
]);

/**
 * True when this argv is a rig-owned command run with `--json` — the strict
 * stdout contract applies. Deliberately NOT true for:
 *
 *   - non-owned verbs (`rig status --json` IS `git status --json`: inherited
 *     stdio, git's own semantics, rig adds nothing);
 *   - flags before the subcommand (`rig --json status`): rig has no global
 *     flags besides help/--version, so the argv passes to git verbatim;
 *   - `--json` after a bare `--` (parseArgs treats those tokens as
 *     positionals, so rig's flag parsers never see it as a flag either).
 *
 * Mirrors a plain token scan rather than each command's full parseArgs
 * config: the one divergence is `--json` consumed as a STRING option's value
 * (e.g. `rig push --relay --json`) — a pathological invocation that ends up
 * with chatter on stderr and a backstop envelope on stdout, which still
 * honors the parse guarantee.
 */
export function isJsonInvocation(argv: string[]): boolean {
  const [verb, ...rest] = argv;
  if (verb === undefined || !RIG_OWNED_VERBS.has(verb)) return false;
  for (const arg of rest) {
    if (arg === '--') return false;
    if (arg === '--json') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Process-level stdout guard (third-party console.log defense)
// ---------------------------------------------------------------------------

/** Handle on an installed stdout guard. */
export interface StdoutGuard {
  /** Write to the REAL stdout (bypasses the redirection). */
  write(text: string): void;
  /** Undo the patch (tests; the one-shot CLI process never needs it). */
  restore(): void;
}

/**
 * Reroute every `process.stdout.write` — including `console.log` from
 * dependencies rig cannot re-route at the io seam, like the embedded
 * client's `[Bootstrap] …` logs (#260) — to stderr. Returns the ONLY writer
 * that still reaches the real stdout; ./rig.ts wires it into
 * {@link makeCliIo}'s `writeStdout` so `emitJson` output is the single
 * survivor on the machine stream.
 *
 * @param realWrite Override the saved real-stdout writer (tests capture it);
 *   defaults to the unpatched `process.stdout.write`.
 */
// ---------------------------------------------------------------------------
// Process-level stderr calmer (third-party bootstrap noise defense, #280)
// ---------------------------------------------------------------------------

/** Handle on an installed stderr calmer. */
export interface StderrCalmer {
  /** Undo the patch (tests; the one-shot CLI process never needs it). */
  restore(): void;
}

/** The embedded client's core self-announce failure log line. */
const ANNOUNCE_FAILED_RE = /\[Bootstrap\] Announce failed/;
/** … specifically the EXPECTED pre-payment 402 refusal (x402 challenge). */
const ANNOUNCE_402_RE = /402|payment required/i;

/**
 * The calm reframe of the announce-402: what happened, why it is expected,
 * and that the command is unaffected — instead of a full x402 challenge JSON
 * dump. Exported so tests pin the exact line.
 */
export const ANNOUNCE_402_INFO =
  'rig: skipped the optional identity self-announce — the payment peer ' +
  'charges for announces and this identity has not paid for one (expected ' +
  'on a fresh or unfunded identity); harmless, the command continues.\n';

/**
 * Reframe the embedded client's scary-but-harmless bootstrap announce noise
 * (#280). The core's bootstrap tries a PAID self-announce and `console.warn`s
 * the refusal — `[Bootstrap] Announce failed …: … (402 Payment Required):
 * {…x402…}` — straight to stderr, which rig's io seam cannot reach. A
 * first-run user reads that as their (succeeding!) push having failed.
 *
 * This process-level guard patches `process.stderr.write`:
 *
 *   - an announce-402 line becomes {@link ANNOUNCE_402_INFO} once per
 *     process (repeats are dropped — one calm line, not one per peer);
 *   - announce failures that are NOT the expected 402 (network errors, peer
 *     misconfig) pass through untouched — those ARE signal;
 *   - everything else passes through untouched.
 *
 * Installed unconditionally in ./rig.ts before dispatch. Composes with
 * {@link redirectStdoutToStderr}: that guard forwards to `process.stderr.write`
 * via a dynamic property lookup, so rerouted stdout noise is calmed too.
 */
export function calmBootstrapNoise(): StderrCalmer {
  const original = process.stderr.write;
  let reframed = false;
  const patched = ((
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void
  ): boolean => {
    let text = chunk;
    if (typeof chunk === 'string' && ANNOUNCE_FAILED_RE.test(chunk)) {
      if (ANNOUNCE_402_RE.test(chunk)) {
        text = reframed ? '' : ANNOUNCE_402_INFO;
        reframed = true;
      }
    }
    return typeof encodingOrCb === 'function'
      ? original.call(process.stderr, text, encodingOrCb)
      : original.call(process.stderr, text, encodingOrCb, cb);
  }) as typeof process.stderr.write;
  process.stderr.write = patched;
  return {
    restore: () => {
      if (process.stderr.write === patched) process.stderr.write = original;
    },
  };
}

export function redirectStdoutToStderr(
  realWrite?: (text: string) => void
): StdoutGuard {
  const original = process.stdout.write;
  const real = realWrite ?? original.bind(process.stdout);
  const patched = ((
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void
  ): boolean =>
    typeof encodingOrCb === 'function'
      ? process.stderr.write(chunk, encodingOrCb)
      : process.stderr.write(
          chunk,
          encodingOrCb,
          cb
        )) as typeof process.stdout.write;
  process.stdout.write = patched;
  return {
    write: (text) => {
      real(text);
    },
    restore: () => {
      if (process.stdout.write === patched) process.stdout.write = original;
    },
  };
}
