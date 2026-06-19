/**
 * @toon-protocol/views — shared kind→atom registry, NIP parsers, filter
 * builders, and the ViewSpec composition language. Consumed by `rig` and the
 * `toon-mcp` apps surface.
 *
 * The React atoms + iframe runtime (atoms/, runtime, app-bridge, app-entry) are
 * built separately into the MCP-app bundle and are not part of this Node barrel.
 */

export * from './types.js';
export * from './filters.js';
export * from './spec.js';
export * from './catalog.js';
export * from './tool-names.js';
export * from './examples.js';
export * from './parsers/nip34.js';
export * from './parsers/social.js';
export * from './parsers/media.js';
