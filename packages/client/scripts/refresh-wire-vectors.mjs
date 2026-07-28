#!/usr/bin/env node
/**
 * Refresh — or just check — the vendored cross-repo wire vectors.
 *
 * `src/wire/vectors/wire-vectors.json` is a verbatim copy of
 * `vectors/wire-vectors.json` on toon-protocol/connector. Vendoring keeps the
 * bytes in this repo's history and keeps `pnpm test` offline; this script is
 * the thing that stops the copy drifting away from the connector unnoticed.
 *
 *   node scripts/refresh-wire-vectors.mjs            # adopt connector main
 *   node scripts/refresh-wire-vectors.mjs --ref <sha># adopt an exact commit
 *   node scripts/refresh-wire-vectors.mjs --check    # fail if we have drifted
 *
 * `--check` is what CI runs (`.github/workflows/wire-vectors-drift.yml`); it
 * writes nothing and exits non-zero when the vendored copy differs from the
 * connector's current `main`.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE_REPO = 'toon-protocol/connector';
const SOURCE_PATH = 'vectors/wire-vectors.json';

const VECTORS_FILE = fileURLToPath(
  new URL('../src/wire/vectors/wire-vectors.json', import.meta.url)
);
const PROVENANCE_FILE = fileURLToPath(
  new URL('../src/wire/vectors/wire-vectors.provenance.json', import.meta.url)
);

const args = process.argv.slice(2);
const check = args.includes('--check');
const refIndex = args.indexOf('--ref');
const ref = refIndex === -1 ? 'main' : args[refIndex + 1];

if (refIndex !== -1 && !ref) {
  console.error('--ref needs a commit sha or branch name');
  process.exit(2);
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github.raw, text/plain, */*' },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
  }
  return response.text();
}

/** The commit the fetched content is pinned to, so provenance is never a guess. */
async function resolveCommit(gitRef) {
  const commits = await fetchText(
    `https://api.github.com/repos/${SOURCE_REPO}/commits?path=${encodeURIComponent(SOURCE_PATH)}&sha=${encodeURIComponent(gitRef)}&per_page=1`
  );
  const [head] = JSON.parse(commits);
  if (!head) throw new Error(`no commits touch ${SOURCE_PATH} at ${gitRef}`);
  return {
    sha: head.sha,
    date: head.commit.committer.date,
    subject: String(head.commit.message).split('\n')[0],
  };
}

const remote = await fetchText(
  `https://raw.githubusercontent.com/${SOURCE_REPO}/${ref}/${SOURCE_PATH}`
);
const local = readFileSync(VECTORS_FILE, 'utf8');

if (check) {
  if (remote === local) {
    console.log(
      `wire vectors are in sync with ${SOURCE_REPO}@${ref} (sha256 ${sha256(local)})`
    );
    process.exit(0);
  }
  console.error(
    [
      `DRIFT: the vendored wire vectors differ from ${SOURCE_REPO}@${ref}.`,
      '',
      `  vendored sha256: ${sha256(local)}`,
      `  connector sha256: ${sha256(remote)}`,
      '',
      'The wire changed. Refresh and make the replay green again:',
      '  pnpm --filter @toon-protocol/client vectors:refresh',
      '  pnpm --filter @toon-protocol/client test',
    ].join('\n')
  );
  process.exit(1);
}

const commit = await resolveCommit(ref);
const parsed = JSON.parse(remote);
const previous = JSON.parse(readFileSync(PROVENANCE_FILE, 'utf8'));

writeFileSync(VECTORS_FILE, remote);
writeFileSync(
  PROVENANCE_FILE,
  `${JSON.stringify(
    {
      ...previous,
      sourceRepo: SOURCE_REPO,
      sourcePath: SOURCE_PATH,
      connectorCommit: commit.sha,
      connectorCommitDate: commit.date,
      connectorCommitSubject: commit.subject,
      schemaVersion: parsed.schema_version,
      sha256: sha256(remote),
    },
    null,
    2
  )}\n`
);

console.log(
  [
    `wire vectors refreshed from ${SOURCE_REPO}@${commit.sha.slice(0, 12)}`,
    `  ${commit.subject}`,
    `  schema_version ${parsed.schema_version}, sha256 ${sha256(remote)}`,
    remote === local
      ? '  (no change — the wire has not moved)'
      : '  CHANGED — run the suite; a failing replay means this client has not caught up.',
  ].join('\n')
);
