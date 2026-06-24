/**
 * Branch 1 — the native-component registry.
 *
 * A `kind → native component` map for the kinds the client knows natively. This
 * is the registry abstraction that {@link renderDispatch} consults first: a hit
 * is branch 1 (full trust), a miss falls through to the unknown-kind branches.
 *
 * The component type `C` is generic so the rendering package
 * (`@toon-protocol/views`) instantiates it with its own component contract (e.g.
 * an `Atom`) — this keeps `@toon-protocol/client` free of any React dependency
 * while still owning the dispatch + registry abstraction (per the epic split:
 * dispatch in `client`, branch-1 components in `views`).
 *
 * Replaces ad-hoc per-kind conditionals with a single register/lookup seam.
 */

/** A native component registered for one or more event kinds. */
export class KindRegistry<C> {
  private readonly byKind = new Map<number, C>();

  /**
   * Register a native `component` as the renderer for one or more event
   * `kinds`. Registering an already-registered kind overwrites it (last write
   * wins) so a host can override a default; pass {@link register} per kind to
   * keep the first registration explicit.
   */
  register(kinds: number | readonly number[], component: C): this {
    const list = typeof kinds === 'number' ? [kinds] : kinds;
    for (const kind of list) {
      this.byKind.set(kind, component);
    }
    return this;
  }

  /** The native component for `kind`, or `undefined` if the kind is unknown. */
  lookup(kind: number): C | undefined {
    return this.byKind.get(kind);
  }

  /** Whether a native component is registered for `kind` (branch 1 applies). */
  has(kind: number): boolean {
    return this.byKind.has(kind);
  }

  /** Every kind with a registered native component. */
  kinds(): number[] {
    return [...this.byKind.keys()];
  }

  /** Number of registered kinds. */
  get size(): number {
    return this.byKind.size;
  }
}
