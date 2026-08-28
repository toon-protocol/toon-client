#!/usr/bin/env node
/**
 * Refresh — or just check — the vendored cross-repo wire vectors.
 *
 * `src/wire/vectors/wire-vectors.json` is a verbatim copy of
 * `vectors/wire-vectors.json` on toon-protocol/connector. Vendoring keeps the
 * bytes in this repo's history and keeps `pnpm test` offline; this script is
 * the thing that stops the copy drifting away from the connector unnoticed.
 *
 *   node scripts/refresh-wire-vectors.mjs                    # adopt connector main
 *   node scripts/refresh-wire-vectors.mjs --ref <sha>        # adopt an exact commit
 *   node scripts/refresh-wire-vectors.mjs --check            # fail if we have drifted
 *   node scripts/refresh-wire-vectors.mjs --from-local <dir> # adopt a LOCAL checkout
 *   node scripts/refresh-wire-vectors.mjs --from-local <dir> --check
 *
 * `--check` (without `--from-local`) is what CI runs
 * (`.github/workflows/wire-vectors-drift.yml`); it writes nothing and exits
 * non-zero when the vendored copy differs from the connector's current `main`.
 *
 * ## `--from-local`
 *
 * Reads `<dir>/vectors/wire-vectors.json` off disk and takes its provenance
 * from that checkout's OWN `git rev-parse HEAD` / `git log -1`. This exists
 * because the bytes being adopted are frequently not on GitHub yet: a wire
 * change lands in a working connector checkout first, and fetching from
 * `main` at that moment vendors the WRONG bytes while reporting a commit that
 * does not contain them — the one failure mode this whole script exists to
 * prevent, arrived at from the other direction.
 *
 * It refuses when the connector's working tree has uncommitted changes to that
 * file. A vendored copy must be attributable to a commit somebody can check
 * out; provenance pointing at a HEAD whose tree does not contain these bytes
 * is worse than no provenance, because it reads as verified.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
const localIndex = args.indexOf('--from-local');
const localPath = localIndex === -1 ? undefined : args[localIndex + 1];

if (refIndex !== -1 && !ref) {
  console.error('--ref needs a commit sha or branch name');
  process.exit(2);
}
if (localIndex !== -1 && !localPath) {
  console.error('--from-local needs a path to a connector checkout');
  process.exit(2);
}
if (localIndex !== -1 && refIndex !== -1) {
  console.error('--from-local and --ref name two different sources; pick one');
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

function git(cwd, ...gitArgs) {
  return execFileSync('git', gitArgs, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Read the vectors and the provenance out of a local connector checkout.
 *
 * Exits non-zero rather than vendoring anything when the file is dirty — see
 * this module's header for why an uncommitted state cannot be a source.
 */
function readLocal(checkout) {
  const root = resolve(checkout);
  const file = join(root, SOURCE_PATH);
  if (!existsSync(file)) {
    console.error(`no ${SOURCE_PATH} under ${root} — is that a connector checkout?`);
    process.exit(2);
  }

  let status;
  try {
    status = git(root, 'status', '--porcelain', '--', SOURCE_PATH);
  } catch (err) {
    console.error(`${root} is not a git checkout (${String(err)})`);
    process.exit(2);
  }
  if (status !== '') {
    console.error(
      [
        `REFUSED: ${SOURCE_PATH} has uncommitted changes in ${root}:`,
        '',
        `  ${status.split('\n').join('\n  ')}`,
        '',
        'A vendored copy has to come from a state someone else can check out.',
        'Commit the vector change in the connector, then re-run this.',
      ].join('\n')
    );
    process.exit(2);
  }

  return {
    text: readFileSync(file, 'utf8'),
    commit: {
      sha: git(root, 'rev-parse', 'HEAD'),
      date: git(root, 'log', '-1', '--format=%cI'),
      subject: git(root, 'log', '-1', '--format=%s'),
    },
    root,
  };
}

const local = localPath ? readLocal(localPath) : undefined;
const source = local ? 'local' : 'github';
const label = local ? `${local.root}@${local.commit.sha.slice(0, 12)}` : `${SOURCE_REPO}@${ref}`;

const remote = local
  ? local.text
  : await fetchText(
      `https://raw.githubusercontent.com/${SOURCE_REPO}/${ref}/${SOURCE_PATH}`
    );
const localCopy = readFileSync(VECTORS_FILE, 'utf8');

if (check) {
  if (remote === localCopy) {
    console.log(
      `wire vectors are in sync with ${label} (sha256 ${sha256(localCopy)})`
    );
    process.exit(0);
  }
  console.error(
    [
      `DRIFT: the vendored wire vectors differ from ${label}.`,
      '',
      `  vendored sha256: ${sha256(localCopy)}`,
      `  connector sha256: ${sha256(remote)}`,
      '',
      'The wire changed. Refresh and make the replay green again:',
      '  pnpm --filter @toon-protocol/client vectors:refresh',
      '  pnpm --filter @toon-protocol/client test',
    ].join('\n')
  );
  process.exit(1);
}

const commit = local ? local.commit : await resolveCommit(ref);
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
      /** Where these exact bytes were read from: a GitHub ref, or a checkout. */
      source,
      /**
       * Always false: this script refuses to vendor from a dirty working tree,
       * and the harness re-asserts it, so a `true` here can only have been
       * hand-written — which is the point of recording it at all.
       */
      dirty: false,
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
    `wire vectors refreshed from ${label} (source: ${source})`,
    `  ${commit.subject}`,
    `  schema_version ${parsed.schema_version}, sha256 ${sha256(remote)}`,
    remote === localCopy
      ? '  (no change — the wire has not moved)'
      : '  CHANGED — run the suite; a failing replay means this client has not caught up.',
  ].join('\n')
);
