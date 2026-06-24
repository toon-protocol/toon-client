/**
 * Onboarding atom — get-started card for new TOON clients.
 * Walks through identity, payment channel, and first publish.
 */
import { type FC } from 'react';
import { Button } from '@/components/ui/button.js';
import { MonoId } from '@/components/mono-id.js';
import { type Atom, type AtomRenderProps } from './types.js';

const DEFAULT_STEPS = [
  'Claim your identity — one mnemonic, every chain.',
  'Open a payment channel to a TOON apex.',
  'Publish your first event. Reads stay free.',
];

const OnboardCard: FC<AtomRenderProps> = ({ props, actions }) => {
  const pubkey = typeof props['pubkey'] === 'string' ? props['pubkey'] : undefined;
  const steps = Array.isArray(props['steps'])
    ? (props['steps'] as unknown[]).map(String)
    : DEFAULT_STEPS;
  const label = typeof props['label'] === 'string' ? props['label'] : 'Publish profile';

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="mb-4">
        <div className="font-semibold">Get started with TOON</div>
        {pubkey ? (
          <MonoId value={pubkey} className="mt-0.5 text-muted-foreground" />
        ) : null}
      </div>
      <ol className="mb-4 flex flex-col gap-2">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-3 text-sm">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
              {i + 1}
            </span>
            <span className="text-muted-foreground">{step}</span>
          </li>
        ))}
      </ol>
      {actions['publish'] ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void actions['publish']?.()}>
            {label}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

export const onboardAtoms: Atom[] = [
  { id: 'onboard-card', writes: [{ name: 'toon_publish_unsigned' }], Component: OnboardCard },
];
