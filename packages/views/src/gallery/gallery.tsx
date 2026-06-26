/**
 * Dev-only visual gallery for the TOON atoms.
 *
 * Renders every reference ViewSpec (plus extra specs that exercise atoms the
 * examples don't reach) through the REAL composition runtime
 * ({@link ViewSpecRenderer}) and a fixture-backed {@link createMockBridge}. No
 * MCP host required — this is what you screenshot/iterate against.
 *
 * Served by the Vite dev server at `/gallery.html`. `?theme=dark` toggles the
 * `.dark` class so the Playwright loop can capture both themes.
 */
import { createRoot } from 'react-dom/client';
import { useState, type ReactNode } from 'react';
import '../globals.css';
import { ViewSpecRenderer } from '../runtime.js';
import { EXAMPLE_VIEWSPECS } from '../examples.js';
import { type ViewSpec } from '../spec.js';
import { createMockBridge } from './mock-bridge.js';
import {
  buildReactionFilter,
  buildCommentFilter,
  buildPRListFilter,
} from '../filters.js';
import { OPEN_CHANNEL_TOOL, SWAP_TOOL, PUBLISH_TOOL, FUND_WALLET_TOOL, CHANNEL_DEPOSIT_TOOL } from '../tool-names.js';
import { PK, CHANNELS, SWAP_PAIR, SETTLEMENT_RECEIPT } from './fixtures.js';

const bridge = createMockBridge();

/** Extra specs covering atoms the reference examples don't surface. */
const EXTRA: { name: string; description: string; spec: ViewSpec }[] = [
  {
    name: 'wallet-overview',
    description: 'Per-chain address (copy-to-share) + live balance + devnet faucet.',
    spec: {
      title: 'Wallet',
      root: { atom: 'wallet-overview', actions: { fund: { tool: FUND_WALLET_TOOL } } },
    },
  },
  {
    name: 'channel-list',
    description: 'Live tracked channels with nonce + available / deposit balance.',
    spec: { title: 'Channels', root: { atom: 'channel-list' } },
  },
  {
    name: 'deposit-form',
    description: 'Pick a channel + amount → spendy on-chain deposit (EVM).',
    spec: {
      title: 'Deposit',
      root: { atom: 'deposit-form', actions: { deposit: { tool: CHANNEL_DEPOSIT_TOOL, spendy: true } } },
    },
  },
  {
    name: 'skeleton',
    description: 'Pulsing placeholders (lines / avatar / card) for the loading state.',
    spec: {
      title: 'Skeleton',
      root: {
        atom: 'stack',
        props: { gap: 4 },
        children: [
          { atom: 'skeleton', props: { variant: 'avatar' } },
          { atom: 'skeleton', props: { variant: 'lines', lines: 3 } },
          { atom: 'skeleton', props: { variant: 'card' } },
        ],
      },
    },
  },
  {
    name: 'loading',
    description: 'Spinner + agent-set status line.',
    spec: { title: 'Loading', root: { atom: 'loading', props: { message: 'Resolving balances…' } } },
  },
  {
    name: 'progress-steps',
    description: 'Numbered stepper for multi-step journeys (active mid-flow).',
    spec: {
      title: 'Progress',
      root: { atom: 'progress-steps', props: { steps: ['Close channel', 'Wait for timeout', 'Settle'], active: 1 } },
    },
  },
  {
    name: 'reaction-bar',
    description: 'NIP-25 reactions aggregated into emoji pills (kind:7).',
    spec: { title: 'Reactions', root: { atom: 'reaction-bar', bind: { query: buildReactionFilter(['n_1']) }, actions: { react: { tool: PUBLISH_TOOL, args: { kind: 7 } } } } },
  },
  {
    name: 'pull-requests',
    description: 'NIP-34 patches/PRs (kind:1617).',
    spec: { title: 'PRs', root: { atom: 'pr-card', bind: { query: buildPRListFilter(PK.linus, 'toon-client'), kindAuto: true } } },
  },
  {
    name: 'comment-thread',
    description: 'NIP-22 comments on an issue (kind:1622).',
    spec: { title: 'Comments', root: { atom: 'comment-thread', bind: { query: buildCommentFilter(['issue_1']) }, actions: { comment: { tool: PUBLISH_TOOL, args: { kind: 1622 } } } } },
  },
  {
    name: 'channels (open)',
    description: 'channel-card with live channels + nonce/cumulative.',
    spec: { title: 'Channels', root: { atom: 'channel-card', props: { channels: CHANNELS }, actions: { open: { tool: OPEN_CHANNEL_TOOL } } } },
  },
  {
    name: 'swap (pair)',
    description: 'swap-form with a configured asset pair + rate.',
    spec: { title: 'Swap', root: { atom: 'swap-form', props: { pair: SWAP_PAIR, label: 'Swap' }, actions: { swap: { tool: SWAP_TOOL, spendy: true } } } },
  },
  {
    name: 'settlement (receipt)',
    description: 'settlement-receipt with a completed multi-claim swap.',
    spec: { title: 'Receipt', root: { atom: 'settlement-receipt', props: { receipt: SETTLEMENT_RECEIPT } } },
  },
  {
    name: 'content primitives',
    description: 'heading + stat + text + key-value + badge in a card.',
    spec: {
      title: 'Primitives',
      root: {
        atom: 'card',
        children: [
          {
            atom: 'stack',
            children: [
              { atom: 'heading', props: { text: 'Network', level: 2 } },
              { atom: 'stack', props: { direction: 'row', gap: 6 }, children: [
                { atom: 'stat', props: { label: 'Fee / event', value: '0.0002', tone: 'success' } },
                { atom: 'stat', props: { label: 'Buffered', value: '128' } },
                { atom: 'stat', props: { label: 'Chains', value: '2/3', tone: 'warn' } },
              ] },
              { atom: 'text', props: { text: 'Reads are free. Writes settle a channel claim per event.', muted: true } },
              { atom: 'key-value', props: { rows: [
                { label: 'Relay', value: 'relay.devnet…' },
                { label: 'Transport', value: 'btp' },
                { label: 'Settlement', value: 'base' },
              ] } },
              { atom: 'badge', props: { label: 'ready', tone: 'success' } },
            ],
          },
        ],
      },
    },
  },
];

const ALL_PANELS = [...EXAMPLE_VIEWSPECS, ...EXTRA];

function Panel({ name, description, spec }: { name: string; description: string; spec: ViewSpec }): ReactNode {
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="border-b border-border px-4 py-2.5">
        <div className="font-mono text-xs font-semibold text-foreground">{name}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</div>
      </header>
      <div className="flex-1 bg-background p-4">
        <ViewSpecRenderer spec={spec} bridge={bridge} />
      </div>
    </section>
  );
}

type ThemeMode = 'light' | 'dark';

const THEME_KEY = 'toon-gallery-theme';

/** Toggle the `.dark` class the atoms' tokens key off of, and remember it. */
function applyTheme(mode: ThemeMode): void {
  document.documentElement.classList.toggle('dark', mode === 'dark');
  document.documentElement.style.colorScheme = mode;
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* private mode / storage disabled — fine, just don't persist */
  }
}

/** Segmented light/dark switch for previewing both themes live. */
function ThemeToggle(): ReactNode {
  const [mode, setMode] = useState<ThemeMode>(
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  );
  const select = (m: ThemeMode): void => {
    applyTheme(m);
    setMode(m);
  };
  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex overflow-hidden rounded-lg border border-border text-xs font-medium"
    >
      {(['light', 'dark'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => select(m)}
          aria-pressed={mode === m}
          className={
            'px-3 py-1.5 capitalize transition-colors ' +
            (mode === m
              ? 'bg-primary text-primary-foreground'
              : 'bg-background text-muted-foreground hover:text-foreground')
          }
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function Gallery(): ReactNode {
  return (
    <div className="min-h-screen bg-muted/30 text-foreground">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-background/80 px-6 py-4 backdrop-blur">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">TOON atom gallery</h1>
          <p className="text-sm text-muted-foreground">
            Every atom, rendered through the real runtime + fixture bridge. Dev-only.
          </p>
        </div>
        <ThemeToggle />
      </header>
      <main className="mx-auto grid max-w-[1400px] grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-5 p-6">
        {ALL_PANELS.map((p) => (
          <Panel key={p.name} {...p} />
        ))}
      </main>
    </div>
  );
}

// Initial theme: `?theme=light|dark` wins (for the Playwright loop / deep links),
// otherwise fall back to the last toggle saved in localStorage.
const params = new URLSearchParams(window.location.search);
const savedTheme = (() => {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
})();
const initialTheme = params.get('theme') ?? savedTheme;
if (initialTheme === 'dark') {
  document.documentElement.classList.add('dark');
  document.documentElement.style.colorScheme = 'dark';
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Gallery />);
