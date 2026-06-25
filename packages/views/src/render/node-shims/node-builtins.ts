/**
 * Browser shim for the Node builtins (`child_process`, `fs/promises`, `os`,
 * `path`, `crypto`) that `@toon-protocol/core`'s root entry top-level-imports for
 * its Node-only devnet `preset` helper. Aliased in by `vite.config.ts` for the
 * MCP-app bundle only.
 *
 * The render trust gradient uses only core's PURE `ui` coordinate helpers; the
 * devnet-preset code that needs these builtins is dead in the iframe. Vite's
 * default `__vite-browser-external` stub does not export the *named* bindings
 * core imports (`execFile`, `mkdtemp`, `tmpdir`, …), which fails the build at
 * link time. This shim exports every name core references so the (dead) imports
 * resolve; any actual call throws — none happens in the browser.
 */

function unavailable(name: string): never {
  throw new Error(`Node builtin "${name}" is not available in the browser bundle`);
}

// child_process
export const execFile = (): never => unavailable('child_process.execFile');

// fs/promises
export const readFile = (): never => unavailable('fs/promises.readFile');
export const writeFile = (): never => unavailable('fs/promises.writeFile');
export const mkdtemp = (): never => unavailable('fs/promises.mkdtemp');
export const cp = (): never => unavailable('fs/promises.cp');
export const rm = (): never => unavailable('fs/promises.rm');

// os
export const tmpdir = (): never => unavailable('os.tmpdir');

// crypto
export const createHash = (): never => unavailable('crypto.createHash');

// path — default import in core; provide the members it could reference.
const pathShim = {
  join: (): never => unavailable('path.join'),
  resolve: (): never => unavailable('path.resolve'),
  dirname: (): never => unavailable('path.dirname'),
  basename: (): never => unavailable('path.basename'),
  sep: '/',
};

export default pathShim;
