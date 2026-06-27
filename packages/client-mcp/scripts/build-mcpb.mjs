#!/usr/bin/env node
/**
 * build-mcpb.mjs — package the built client-mcp into a Claude Desktop
 * extension (`.mcpb`), the one-click install format for local MCP servers.
 *
 * Why this exists: the Claude Code plugin (`toon-plugin/.mcp.json`) only reaches
 * Claude Code. Desktop installs local servers via an `.mcpb` bundle (Settings →
 * Extensions). Both ship the SAME `@toon-protocol/client-mcp` server — this just
 * produces the Desktop wrapper. See packages/client-mcp/mcpb/manifest.json.
 *
 * How: we `npm pack` the already-built package to a tarball, then `npm install`
 * that tarball into a clean staging tree. That yields a real, flat node_modules
 * (runtime + optional deps resolved from npm) laid out exactly as a consumer
 * would get — no pnpm workspace symlinks to confuse Node's resolver. Then we
 * drop in the version-stamped manifest and run `mcpb pack`.
 *
 * Packing the local tarball (not `npm install @toon-protocol/client-mcp@x`) means
 * the bundle matches the bits we just built and does NOT depend on npm-registry
 * propagation — so this is safe to run in the same CI job that publishes.
 *
 * Usage:
 *   node scripts/build-mcpb.mjs [--out <path>] [--no-optional]
 *
 *   --out <path>     output .mcpb file (default: <pkg>/dist-mcpb/toon-<version>.mcpb)
 *   --no-optional    omit optionalDependencies (o1js / mina-signer / @solana/web3.js);
 *                    smaller bundle, but Solana/Mina on-chain paths degrade gracefully.
 *
 * Prereq: the package must be built first (`pnpm --filter @toon-protocol/client-mcp build`).
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..'); // packages/client-mcp

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const noOptional = argv.includes('--no-optional');
const outIdx = argv.indexOf('--out');
const outArg = outIdx !== -1 ? argv[outIdx + 1] : null;

// ── read package metadata ────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const { name, version } = pkg;

const distEntry = join(pkgDir, 'dist', 'mcp.js');
if (!existsSync(distEntry)) {
  console.error(
    `[mcpb] ${name} is not built — missing ${distEntry}.\n` +
      `       Run: pnpm --filter ${name} build`
  );
  process.exit(1);
}

const run = (cmd, args, cwd) => {
  console.log(`[mcpb] $ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
};

// ── 1. pack the built package to a tarball ───────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'toon-mcpb-'));
const tarDir = join(work, 'tar');
const staging = join(work, 'staging');
mkdirSync(tarDir, { recursive: true });
mkdirSync(staging, { recursive: true });

run('npm', ['pack', '--pack-destination', tarDir], pkgDir);
const tarball = readdirSync(tarDir).find((f) => f.endsWith('.tgz'));
if (!tarball) {
  console.error('[mcpb] npm pack produced no tarball');
  process.exit(1);
}

// ── 2. install the tarball into a clean staging tree ─────────────────────────
// A minimal package.json keeps npm from walking up into the monorepo.
writeFileSync(
  join(staging, 'package.json'),
  JSON.stringify({ name: 'toon-mcpb-bundle', version, private: true }, null, 2)
);
const installArgs = [
  'install',
  join(tarDir, tarball),
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  '--no-package-lock',
];
if (noOptional) installArgs.push('--omit=optional');
run('npm', installArgs, staging);

// ── 3. write the version-stamped manifest ────────────────────────────────────
const manifestTemplate = readFileSync(
  join(pkgDir, 'mcpb', 'manifest.json'),
  'utf8'
);
const manifest = manifestTemplate.replaceAll('__VERSION__', version);
JSON.parse(manifest); // fail loudly if substitution broke JSON
writeFileSync(join(staging, 'manifest.json'), manifest);

// Sanity: the entry the manifest points at must exist in the staged tree.
const entryRel = 'node_modules/@toon-protocol/client-mcp/dist/mcp.js';
if (!existsSync(join(staging, entryRel))) {
  console.error(`[mcpb] staged bundle is missing entry point: ${entryRel}`);
  process.exit(1);
}

// ── 4. pack the .mcpb ────────────────────────────────────────────────────────
const outDir = outArg ? dirname(resolve(outArg)) : join(pkgDir, 'dist-mcpb');
mkdirSync(outDir, { recursive: true });
const out = outArg
  ? resolve(outArg)
  : join(outDir, `toon-${version}.mcpb`);

run('npx', ['--yes', '@anthropic-ai/mcpb@2', 'pack', staging, out], pkgDir);

// ── 5. report + leave the artifact, clean the scratch tree ───────────────────
const sizeMb = (statSync(out).size / 1024 / 1024).toFixed(1);
rmSync(work, { recursive: true, force: true });
console.log(`[mcpb] ✅ built ${out} (${sizeMb} MB)`);

// Re-export the path for CI to capture via stdout if needed.
if (process.env['GITHUB_OUTPUT']) {
  writeFileSync(process.env['GITHUB_OUTPUT'], `mcpb_path=${out}\n`, {
    flag: 'a',
  });
}
