/**
 * Shared MCP tool / resource names for the TOON apps surface.
 *
 * Node-safe (no React) so both the iframe runtime and the server can import them
 * and stay in lockstep.
 */

/** Resolves a NIP-01 filter to events (free read). */
export const QUERY_TOOL = 'toon_query';
/** Returns the atom catalog so the agent can compose valid ViewSpecs. */
export const ATOMS_TOOL = 'toon_atoms';
/** Accepts an agent-authored ViewSpec; carries `_meta.ui.resourceUri`. */
export const RENDER_TOOL = 'toon_render';
/** Pay-to-write: daemon signs + publishes the supplied event shell. */
export const PUBLISH_TOOL = 'toon_publish_unsigned';
/** Spendy: upload media to Arweave then publish a referencing event. */
export const UPLOAD_TOOL = 'toon_upload_media';

/** The single MCP-app UI resource the host renders. */
export const APP_RESOURCE_URI = 'ui://toon/app';

/** Write tools the runtime/validator permit an action to target. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([PUBLISH_TOOL, UPLOAD_TOOL]);
