/**
 * Profile editor atom — compose/update a NIP-01 kind:0 metadata event.
 *
 * Unlike `onboard-card` (which fires a preset publish with hardcoded args), this
 * atom collects the profile fields (name / display name / picture / about /
 * nip05) from input fields, serializes them into the kind:0 `content` JSON, and
 * publishes via `toon_publish_unsigned` ({ kind: 0, content }) through the normal
 * pay-to-write confirm flow. When a kind:0 event is bound (free read), the form
 * pre-fills from it and unknown JSON fields are preserved on republish.
 */
import { useEffect, useState, type FC, type ReactNode } from 'react';
import { ArrowLeft, CircleCheck, Coins, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { MonoId } from '@/components/mono-id.js';
import { parseProfile } from '../parsers/social.js';
import { type Atom, type AtomRenderProps, type AtomStatus } from './types.js';
import { byteLength } from './social-ui.js';

/** Editable kind:0 fields, in display order. */
interface ProfileForm {
  name: string;
  display_name: string;
  picture: string;
  about: string;
  nip05: string;
}

const EMPTY_FORM: ProfileForm = {
  name: '',
  display_name: '',
  picture: '',
  about: '',
  nip05: '',
};

/** kind:0 keys this editor owns; everything else on a bound profile is preserved. */
const EDITOR_KEYS = new Set([
  'name',
  'display_name',
  'displayName',
  'picture',
  'about',
  'nip05',
]);

/**
 * Build the kind:0 `content` JSON from the form. Starts from any preserved
 * fields the bound profile carried (banner / lud16 / website / …) so a republish
 * doesn't drop metadata the editor doesn't surface; empty inputs delete their key.
 */
function buildContent(form: ProfileForm, preserved: Record<string, unknown>): string {
  // `preserved` never carries the editor's own keys, so trimmed-empty fields are
  // simply omitted (no delete) and a cleared field drops from the published JSON.
  const content: Record<string, unknown> = { ...preserved };
  for (const [key, value] of Object.entries(form)) {
    const trimmed = value.trim();
    if (trimmed) content[key] = trimmed;
  }
  return JSON.stringify(content);
}

type EditPhase = 'idle' | 'confirming' | 'publishing' | 'receipt';

const FieldRow: FC<{
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}> = ({ id, label, hint, children }) => (
  <label htmlFor={id} className="flex flex-col gap-1">
    <span className="text-xs font-medium text-muted-foreground">
      {label}
      {hint ? <span className="ml-1.5 font-normal opacity-70">{hint}</span> : null}
    </span>
    {children}
  </label>
);

const ProfileEditor: FC<AtomRenderProps> = ({ events, props, actions, readStatus }) => {
  const label = typeof props['label'] === 'string' ? props['label'] : 'Save profile';

  // Pre-fill from a bound kind:0, when present. Preserve unknown raw fields so a
  // republish keeps metadata this editor doesn't surface (banner, lud16, …).
  const bound = events.map(parseProfile).find((p) => p !== null) ?? null;
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM);
  const [preserved, setPreserved] = useState<Record<string, unknown>>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (hydrated || !bound) return;
    setForm({
      name: bound.name ?? '',
      display_name: bound.displayName ?? '',
      picture: bound.picture ?? '',
      about: bound.about ?? '',
      nip05: bound.nip05 ?? '',
    });
    setPreserved(
      Object.fromEntries(Object.entries(bound.raw).filter(([k]) => !EDITOR_KEYS.has(k)))
    );
    setHydrated(true);
  }, [bound, hydrated]);

  const [phase, setPhase] = useState<EditPhase>('idle');
  const [status, setStatus] = useState<AtomStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [eventId, setEventId] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (phase !== 'confirming' || status || statusError || !readStatus) return;
    let cancelled = false;
    void readStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatusError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [phase, status, statusError, readStatus]);

  const set = (key: keyof ProfileForm) => (value: string): void =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const hasAny = Object.values(form).some((v) => v.trim());
  const content = buildContent(form, preserved);
  const bytes = byteLength(content);

  const review = (): void => {
    if (!hasAny || !actions['publish']) return;
    setFailed(null);
    setPhase('confirming');
  };

  const cancel = (): void => setPhase('idle');

  const confirm = async (): Promise<void> => {
    if (!hasAny || !actions['publish']) return;
    setPhase('publishing');
    const outcome = await actions['publish']({ content });
    if (!outcome || outcome.ok === false) {
      setFailed(outcome?.error ?? 'unknown');
      setPhase('confirming');
      return;
    }
    setEventId(outcome.eventId ?? null);
    setPhase('receipt');
  };

  const feeLabel = status
    ? `${status.feePerEvent}${status.asset ? ` ${status.asset}` : ''}`
    : statusError
      ? 'unavailable'
      : '…';
  const chainLabel = status ? status.settlementChain : statusError ? 'unknown' : '…';

  if (phase === 'receipt') {
    return (
      <div className="overflow-hidden rounded-xl border border-primary/30 bg-card">
        <div className="flex items-center gap-2.5 border-b border-primary/20 bg-primary/5 px-4 py-3">
          <CircleCheck aria-hidden="true" className="size-5 text-primary" />
          <div>
            <div className="font-semibold leading-tight">Profile saved — and paid</div>
            <p className="text-xs text-muted-foreground">Your kind:0 metadata is live.</p>
          </div>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-xs">
          <dt className="text-muted-foreground">Event</dt>
          <dd>{eventId ? <MonoId value={eventId} prefixLen={12} suffixLen={6} /> : '—'}</dd>
          <dt className="text-muted-foreground">Fee paid</dt>
          <dd className="font-medium">
            {feeLabel} on {chainLabel}
          </dd>
        </dl>
        <div className="flex justify-end border-t border-border px-4 py-2.5">
          <Button variant="outline" size="sm" onClick={() => setPhase('idle')}>
            Edit again
          </Button>
        </div>
      </div>
    );
  }

  if (phase === 'confirming' || phase === 'publishing') {
    const publishing = phase === 'publishing';
    const displayName = form.display_name.trim() || form.name.trim() || 'your profile';
    return (
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Coins aria-hidden="true" className="size-4 text-primary" />
          <span className="text-sm font-semibold">Confirm pay-to-write</span>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3">
          <p className="text-sm">
            Publish profile metadata for <span className="font-semibold">{displayName}</span> as a
            kind:0 event.
          </p>
          <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
            <div className="flex items-center gap-1.5">
              <dt className="text-muted-foreground">Fee</dt>
              <dd className="font-medium tabular-nums">{feeLabel}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-muted-foreground">Settles on</dt>
              <dd className="font-medium">{chainLabel}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-muted-foreground">Size</dt>
              <dd className="font-mono font-medium tabular-nums">{bytes} bytes</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            Saving your profile pays the fee above. The message is the money.
          </p>
          {failed ? (
            <p className="text-xs text-destructive">Publish failed: {failed}</p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
          <Button variant="outline" size="sm" disabled={publishing} onClick={cancel}>
            <ArrowLeft aria-hidden="true" />
            Back
          </Button>
          <Button size="sm" disabled={publishing || statusError} onClick={() => void confirm()}>
            {publishing ? (
              <>
                <Loader2 aria-hidden="true" className="animate-spin" />
                Publishing…
              </>
            ) : (
              <>
                <Coins aria-hidden="true" />
                Confirm &amp; pay
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <span className="text-sm font-semibold">{bound ? 'Edit profile' : 'Create profile'}</span>
        {bound ? (
          <MonoId value={bound.pubkey} className="text-muted-foreground" />
        ) : null}
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">
        <FieldRow id="profile-name" label="Name">
          <Input
            id="profile-name"
            value={form.name}
            onChange={(e) => set('name')(e.target.value)}
            placeholder="satoshi"
          />
        </FieldRow>
        <FieldRow id="profile-display-name" label="Display name" hint="optional">
          <Input
            id="profile-display-name"
            value={form.display_name}
            onChange={(e) => set('display_name')(e.target.value)}
            placeholder="Satoshi Nakamoto"
          />
        </FieldRow>
        <FieldRow id="profile-picture" label="Picture URL" hint="optional">
          <Input
            id="profile-picture"
            type="url"
            inputMode="url"
            value={form.picture}
            onChange={(e) => set('picture')(e.target.value)}
            placeholder="https://…/avatar.png"
          />
        </FieldRow>
        <FieldRow id="profile-about" label="About" hint="optional">
          <Textarea
            id="profile-about"
            value={form.about}
            onChange={(e) => set('about')(e.target.value)}
            placeholder="A short bio."
            rows={3}
            className="resize-none text-base md:text-sm"
          />
        </FieldRow>
        <FieldRow id="profile-nip05" label="NIP-05 identifier" hint="optional">
          <Input
            id="profile-nip05"
            value={form.nip05}
            onChange={(e) => set('nip05')(e.target.value)}
            placeholder="name@example.com"
          />
        </FieldRow>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
        <span
          className="font-mono text-xs text-muted-foreground tabular-nums"
          title="Fees scale with encoded bytes"
        >
          {bytes} {bytes === 1 ? 'byte' : 'bytes'}
        </span>
        <Button
          size="sm"
          disabled={!hasAny || !actions['publish']}
          onClick={review}
        >
          <Coins aria-hidden="true" />
          {label}
        </Button>
      </div>
    </div>
  );
};

export const profileEditorAtoms: Atom[] = [
  {
    id: 'profile-editor',
    writes: [{ name: 'toon_publish_unsigned' }],
    Component: ProfileEditor,
  },
];
