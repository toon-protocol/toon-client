/**
 * Atom registry — the vocabulary the agent composes with.
 *
 * Keyed two ways: by atom `id` (hand-composition via ViewSpec) and by event
 * `kind` (auto-render for feeds / `kindAuto` binds). Adding a NIP = add a parser
 * + an atom here, and both the MCP-app and rig surfaces light up.
 */

import { KindRegistry } from '@toon-protocol/client/render';
import { type Atom } from './types.js';
import { layoutAtoms } from './layout.js';
import { socialAtoms } from './social.js';
import { feedAtoms } from './feed.js';
import { threadAtoms } from './thread-view.js';
import { mediaAtoms } from './media.js';
import { mediaGalleryAtoms } from './media-gallery.js';
import { liveTickerAtoms } from './live-ticker.js';
import { forgeAtoms } from './forge.js';
import { interactiveAtoms } from './interactive.js';
import { defiAtoms } from './defi.js';
import { onboardAtoms } from './onboard.js';
import { profileEditorAtoms } from './profile-editor.js';
import { contentAtoms } from './content.js';
import { statusAtoms } from './status.js';
import { loadingAtoms } from './loading.js';
import { walletAtoms } from './wallet.js';
import { fallbackAtom, GENERIC_ATOM_ID } from './fallback.js';

const ALL_ATOMS: Atom[] = [
  ...layoutAtoms,
  ...socialAtoms,
  ...feedAtoms,
  ...threadAtoms,
  ...mediaAtoms,
  ...mediaGalleryAtoms,
  ...liveTickerAtoms,
  ...forgeAtoms,
  ...interactiveAtoms,
  ...defiAtoms,
  ...onboardAtoms,
  ...profileEditorAtoms,
  ...contentAtoms,
  ...statusAtoms,
  ...loadingAtoms,
  ...walletAtoms,
  fallbackAtom,
];

/** Atom id → Atom. */
export const ATOMS: ReadonlyMap<string, Atom> = new Map(ALL_ATOMS.map((a) => [a.id, a]));

/** All registered atom ids (the ViewSpec validator allowlist). */
export const ATOM_IDS: ReadonlySet<string> = new Set(ATOMS.keys());

const KIND_DEFAULT: ReadonlyMap<number, Atom> = (() => {
  const map = new Map<number, Atom>();
  for (const atom of ALL_ATOMS) {
    for (const kind of atom.kinds ?? []) {
      if (!map.has(kind)) map.set(kind, atom);
    }
  }
  return map;
})();

/** The default atom for an event kind, or the generic fallback. */
export function defaultAtomForKind(kind: number): Atom {
  return KIND_DEFAULT.get(kind) ?? fallbackAtom;
}

/** The generic fallback atom (used for unknown kinds / invalid nodes). */
export function fallbackAtomFor(): Atom {
  return fallbackAtom;
}

/**
 * Build the branch-1 native-component {@link KindRegistry} from the catalog's
 * atom→kind metadata — the `KindRegistry<Atom>` the render trust gradient
 * (`guardedRenderDispatch`) consults first. A hit is branch 1 (a known kind,
 * full trust → render the atom natively); a miss falls through to the
 * unknown-kind branches (A2UI / mcp-ui / generative).
 *
 * Each atom is registered under every kind it declares in {@link Atom.kinds},
 * first-registered-wins (matching {@link KIND_DEFAULT}) so the same atom resolves
 * for a kind here as via {@link defaultAtomForKind}. The generic fallback atom is
 * deliberately NOT registered: an unknown kind must miss the registry so the
 * gradient can route it, not be silently swallowed as "native".
 */
export function buildKindRegistry(): KindRegistry<Atom> {
  const registry = new KindRegistry<Atom>();
  for (const atom of ALL_ATOMS) {
    if (atom === fallbackAtom) continue;
    for (const kind of atom.kinds ?? []) {
      if (!registry.has(kind)) registry.register(kind, atom);
    }
  }
  return registry;
}

export { GENERIC_ATOM_ID };
export { type Atom, type AtomRenderProps, type AtomAction, type ActionOutcome } from './types.js';
