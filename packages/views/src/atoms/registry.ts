/**
 * Atom registry — the vocabulary the agent composes with.
 *
 * Keyed two ways: by atom `id` (hand-composition via ViewSpec) and by event
 * `kind` (auto-render for feeds / `kindAuto` binds). Adding a NIP = add a parser
 * + an atom here, and both the MCP-app and rig surfaces light up.
 */

import { type Atom } from './types.js';
import { layoutAtoms } from './layout.js';
import { socialAtoms } from './social.js';
import { mediaAtoms } from './media.js';
import { forgeAtoms } from './forge.js';
import { interactiveAtoms } from './interactive.js';
import { defiAtoms } from './defi.js';
import { fallbackAtom, GENERIC_ATOM_ID } from './fallback.js';

const ALL_ATOMS: Atom[] = [
  ...layoutAtoms,
  ...socialAtoms,
  ...mediaAtoms,
  ...forgeAtoms,
  ...interactiveAtoms,
  ...defiAtoms,
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

export { GENERIC_ATOM_ID };
export { type Atom, type AtomRenderProps, type AtomAction, type ActionOutcome } from './types.js';
