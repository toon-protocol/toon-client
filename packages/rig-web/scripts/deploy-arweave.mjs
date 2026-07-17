#!/usr/bin/env node
/**
 * Deploy the built rig-web `dist/` to Arweave on ArDrive Turbo's FREE tier —
 * the permanent, decentralized deployment the README's "Deploying" section
 * describes, unblocked by two facts proven live (toon-client#382):
 *
 *  1. Every build output gzips under the 105 KiB free-tier per-file cap once
 *     shiki uses its JS engine (no 600 KiB wasm) and vite splits vendors per
 *     package (vite.config.ts manualChunks).
 *  2. ar.io gateways forward a data item's `Content-Encoding` tag as the
 *     response header, so files uploaded GZIPPED decompress natively in the
 *     browser (verified: tx YhqW6fT8rYiBVezGqo2ApTrEW0C6tDNLHzMfQsduKYI).
 *
 * Each file uploads as its own gzipped data item (Content-Type +
 * Content-Encoding: gzip tags); an ar.io path manifest (uploaded raw — the
 * gateway must parse it) maps paths → txids with `index.html` as the index.
 * The manifest txId is the deployment: `https://<gateway>/<manifestTx>/`.
 *
 * Signing uses an EPHEMERAL JWK — free-tier uploads spend nothing, so there
 * is no wallet to protect. Usage:
 *
 *   node scripts/deploy-arweave.mjs [distDir]   (default: ../dist)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { TurboFactory } from '@ardrive/turbo-sdk';
import Arweave from 'arweave';

const FREE_TIER_LIMIT = 107_520; // bytes per file (upload.ardrive.io)
const CONCURRENCY = 4;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const distDir = resolve(
  process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
);
const files = walk(distDir).filter((f) => !f.endsWith('.map'));
console.error(`deploying ${files.length} files from ${distDir}`);

const arweave = Arweave.init({});
const jwk = await arweave.crypto.generateJWK();
const turbo = TurboFactory.authenticated({ privateKey: jwk });

async function uploadItem(bytes, contentType, encoding) {
  const tags = [
    { name: 'Content-Type', value: contentType },
    ...(encoding ? [{ name: 'Content-Encoding', value: encoding }] : []),
    { name: 'App-Name', value: 'rig-web' },
  ];
  const result = await turbo.uploadFile({
    fileStreamFactory: () => Readable.from(bytes),
    fileSizeFactory: () => bytes.length,
    dataItemOpts: { tags },
  });
  return result.id;
}

// ── Per-file gzipped uploads (bounded concurrency + one retry) ─────────────
const paths = {};
let done = 0;
const queue = [...files];
async function worker() {
  for (;;) {
    const file = queue.shift();
    if (!file) return;
    const path = relative(distDir, file);
    const raw = readFileSync(file);
    const gz = gzipSync(raw, { level: 9 });
    if (gz.length > FREE_TIER_LIMIT) {
      throw new Error(
        `${path} gzips to ${gz.length} bytes — over the ${FREE_TIER_LIMIT} free-tier cap; ` +
          'split it further in vite.config.ts manualChunks'
      );
    }
    const contentType = MIME[extname(file)] ?? 'application/octet-stream';
    let txId;
    try {
      txId = await uploadItem(gz, contentType, 'gzip');
    } catch (err) {
      console.error(`  retry ${path}: ${err.message ?? err}`);
      await new Promise((r) => setTimeout(r, 2000));
      txId = await uploadItem(gz, contentType, 'gzip');
    }
    paths[path] = { id: txId };
    done += 1;
    console.error(`  [${done}/${files.length}] ${path} → ${txId} (${raw.length}→${gz.length}B)`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// ── Path manifest (raw — gateways parse it server-side) ────────────────────
const manifest = {
  manifest: 'arweave/paths',
  version: '0.2.0',
  index: { path: 'index.html' },
  paths,
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const manifestTx = await uploadItem(
  manifestBytes,
  'application/x.arweave-manifest+json'
);

console.error(`manifest → ${manifestTx}`);

// ── --verify: poll every path through the manifest until it actually serves.
// Upload receipts are NOT proof of seeding: a 122-file deploy shipped with 2
// items the bundler dropped (each needed a re-upload + patched manifest), and
// ONE missing chunk white-pages the whole module graph. Never point the Rig
// pointer at an unverified deployment.
if (process.argv.includes('--verify')) {
  const base = `https://arweave.net/${manifestTx}`;
  const pending = new Set([...Object.keys(paths), '']);
  const deadline = Date.now() + 90 * 60 * 1000;
  while (pending.size > 0 && Date.now() < deadline) {
    for (const p of [...pending]) {
      try {
        const res = await fetch(`${base}/${p}`, { redirect: 'follow' });
        if (res.ok) pending.delete(p);
        await res.arrayBuffer();
      } catch {
        // unreachable right now — retried next round
      }
    }
    if (pending.size > 0) {
      console.error(`  waiting on ${pending.size} path(s)…`);
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }
  if (pending.size > 0) {
    console.error(`VERIFY FAILED — still unseeded: ${[...pending].slice(0, 5).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.error('verified: every path serves through the manifest ✓');
  }
}

console.log(
  JSON.stringify(
    {
      manifestTx,
      url: `https://arweave.net/${manifestTx}/`,
      files: files.length,
      entryJs: Object.keys(paths).find((p) => /^assets\/index-.*\.js$/.test(p)),
      entryCss: Object.keys(paths).find((p) => /^assets\/index-.*\.css$/.test(p)),
    },
    null,
    2
  )
);
