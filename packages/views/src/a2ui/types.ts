/**
 * A2UI message + catalog types for branch 2 of the NIP-on-TOON render trust
 * gradient (toon-meta#58, toon-client#89).
 *
 * Branch 2 renders an **unknown** Nostr kind through the client's *own audited*
 * A2UI catalog at MEDIUM trust — never provider code. The binding convention
 * (spec §"Branch 2 — A2UI binding convention"):
 *
 *   - the `kind:31036` renderer's `content` is the A2UI **`surfaceUpdate`** — the
 *     durable template stored once on the renderer event, and
 *   - the decoded TOON event (`core.decodeEventFromToon` → NostrEvent) is fed in
 *     as the **`dataModelUpdate`** — the data bound into the template.
 *
 * These types model the **v0.8-flavoured** A2UI envelope the spec/issue#89 name
 * (`surfaceUpdate` / `dataModelUpdate` / `beginRendering`) using A2UI v0.9's
 * *flattened* component-node shape (`{ id, component: "<Type>", ...props }`),
 * which is what the catalog gate validates. We model only what branch 2 needs;
 * the wider A2UI surface (createSurface/theme/streaming, client-defined
 * functions) is intentionally **out of scope** here — see the deferral notes.
 *
 * Standard-catalog-only invariant (critical): only the A2UI **"Basic"** catalog
 * is permitted at medium trust. Any custom/non-standard component reference, or
 * any client-defined behavior, must REFUSE to render here and signal a drop to
 * branch 3 (sandboxed mcp-ui). Enforcement lives in `validate.ts`.
 */

/**
 * The A2UI **Basic** (standard) catalog component types we support at medium
 * trust. Deliberately a *curated, presentational* subset of the published Basic
 * catalog: static layout + content components that are safe to render from
 * untrusted template data with no client-defined behavior.
 *
 * Components in the published Basic catalog that imply behavior / interactivity
 * or client-defined functions (Button actions, TextField/CheckBox/Slider/
 * ChoicePicker/DateTimeInput inputs, Modal, Tabs, Video/AudioPlayer) are
 * intentionally NOT in this set: branch 2 is a *read-only* binding of decoded
 * event data into a template. A surface that references them is treated as
 * carrying custom behavior and is dropped to branch 3. (Deferred — see #90.)
 */
export const A2UI_BASIC_CATALOG = [
  'Text',
  'Heading',
  'Image',
  'Icon',
  'Row',
  'Column',
  'List',
  'Card',
  'Divider',
] as const;

/** A supported Basic-catalog component type. */
export type A2uiBasicComponent = (typeof A2UI_BASIC_CATALOG)[number];

/** O(1) membership set for the catalog gate. */
export const A2UI_BASIC_CATALOG_SET: ReadonlySet<string> = new Set(A2UI_BASIC_CATALOG);

/**
 * The A2UI version this renderer implements. The `["a2ui", "<version>"]` tag on
 * the `kind:31036` renderer is checked against this; an unsupported version
 * falls through gracefully (the dispatch can route to branch 1/4). We accept the
 * v0.8 binding-convention vocabulary the spec names.
 */
export const SUPPORTED_A2UI_VERSION = 'v0.8';

/**
 * Versions this renderer accepts. A renderer with no `["a2ui", …]` tag is
 * treated as the supported default (the `m`-tag already selected A2UI).
 */
export const SUPPORTED_A2UI_VERSIONS: ReadonlySet<string> = new Set([SUPPORTED_A2UI_VERSION]);

/**
 * A data-bound property value: either a literal, or a `{ path }` JSON-Pointer
 * binding into the `dataModelUpdate` root. We accept both the v0.9 short form
 * (`{ path: "/a/b" }`) and the v0.8 long form (`{ literalString: "…" }`).
 */
export type A2uiBoundValue =
  | string
  | number
  | boolean
  | { path: string }
  | { literalString: string }
  | { literalNumber: number }
  | { literalBoolean: boolean };

/**
 * A single A2UI component node (flattened form). `component` names the type;
 * `children` references child node ids; all other keys are component props that
 * may carry literals or `{ path }` bindings.
 */
export interface A2uiComponentNode {
  /** Unique node id. The tree root has `id: "root"` by convention. */
  id: string;
  /** The component type name (validated against the Basic catalog). */
  component: string;
  /** Child node ids (for container components: Row / Column / List / Card). */
  children?: string[];
  /** Remaining props (literals or `{ path }` bindings). */
  [prop: string]: unknown;
}

/** The `surfaceUpdate` carried in the `kind:31036` renderer `content`. */
export interface A2uiSurfaceUpdate {
  surfaceId?: string;
  /** The flat list of component nodes making up the template. */
  components: A2uiComponentNode[];
  /**
   * Optional explicit root id (v0.8 `beginRendering.root`). Defaults to the node
   * with `id: "root"`, else the first component.
   */
  root?: string;
}

/**
 * The `dataModelUpdate` — the root data object bound into the template. Branch 2
 * feeds the decoded TOON event here (see {@link dataModelFromEvent}).
 */
export type A2uiDataModel = Record<string, unknown>;
