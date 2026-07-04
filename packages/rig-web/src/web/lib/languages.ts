/**
 * Dependency-free file-extension -> language lookup for Rig-UI, plus a
 * "primary language" picker (GitHub's repo-list language badge, but computed
 * client-side from a sampled file listing instead of a server-side linguist
 * pass).
 *
 * Pure module — no React, no network, no repo/relay knowledge — so it's easy
 * to unit-test and to reuse anywhere a list of file names needs a language
 * guess (repo list, file tree, etc).
 */

/** A recognized programming/markup language. */
export interface Language {
  /** Display name, e.g. "TypeScript". */
  name: string;
  /** GitHub's linguist color for this language (hex), or a neutral gray for
   *  languages GitHub doesn't assign a color to. */
  color: string;
}

/**
 * Lowercased file extension (without the leading dot) -> Language.
 * Colors match GitHub's linguist `languages.yml` where one exists.
 */
export const LANGUAGE_BY_EXT: Record<string, Language> = {
  // JavaScript / TypeScript
  js: { name: 'JavaScript', color: '#f1e05a' },
  jsx: { name: 'JavaScript', color: '#f1e05a' },
  mjs: { name: 'JavaScript', color: '#f1e05a' },
  cjs: { name: 'JavaScript', color: '#f1e05a' },
  ts: { name: 'TypeScript', color: '#3178c6' },
  tsx: { name: 'TypeScript', color: '#3178c6' },
  mts: { name: 'TypeScript', color: '#3178c6' },
  cts: { name: 'TypeScript', color: '#3178c6' },

  // Scripting / systems
  py: { name: 'Python', color: '#3572A5' },
  pyw: { name: 'Python', color: '#3572A5' },
  rs: { name: 'Rust', color: '#dea584' },
  go: { name: 'Go', color: '#00ADD8' },
  sol: { name: 'Solidity', color: '#AA6746' },
  java: { name: 'Java', color: '#b07219' },
  c: { name: 'C', color: '#555555' },
  h: { name: 'C', color: '#555555' },
  cpp: { name: 'C++', color: '#f34b7d' },
  cc: { name: 'C++', color: '#f34b7d' },
  cxx: { name: 'C++', color: '#f34b7d' },
  hpp: { name: 'C++', color: '#f34b7d' },
  hh: { name: 'C++', color: '#f34b7d' },
  rb: { name: 'Ruby', color: '#701516' },
  php: { name: 'PHP', color: '#4F5D95' },
  cs: { name: 'C#', color: '#178600' },
  swift: { name: 'Swift', color: '#F05138' },
  kt: { name: 'Kotlin', color: '#A97BFF' },
  kts: { name: 'Kotlin', color: '#A97BFF' },
  scala: { name: 'Scala', color: '#c22d40' },
  m: { name: 'Objective-C', color: '#438eff' },
  mm: { name: 'Objective-C', color: '#438eff' },
  pl: { name: 'Perl', color: '#0298c3' },
  pm: { name: 'Perl', color: '#0298c3' },
  hs: { name: 'Haskell', color: '#5e5086' },
  lua: { name: 'Lua', color: '#000080' },
  r: { name: 'R', color: '#198CE7' },
  dart: { name: 'Dart', color: '#00B4AB' },
  ex: { name: 'Elixir', color: '#6e4a7e' },
  exs: { name: 'Elixir', color: '#6e4a7e' },
  clj: { name: 'Clojure', color: '#db5855' },
  cljs: { name: 'Clojure', color: '#db5855' },
  cljc: { name: 'Clojure', color: '#db5855' },
  zig: { name: 'Zig', color: '#ec915c' },
  nim: { name: 'Nim', color: '#ffc200' },
  jl: { name: 'Julia', color: '#a270ba' },
  ps1: { name: 'PowerShell', color: '#012456' },

  // Shell
  sh: { name: 'Shell', color: '#89e051' },
  bash: { name: 'Shell', color: '#89e051' },
  zsh: { name: 'Shell', color: '#89e051' },

  // Web
  html: { name: 'HTML', color: '#e34c26' },
  htm: { name: 'HTML', color: '#e34c26' },
  css: { name: 'CSS', color: '#563d7c' },
  scss: { name: 'SCSS', color: '#c6538c' },
  vue: { name: 'Vue', color: '#41b883' },
  svelte: { name: 'Svelte', color: '#ff3e00' },
  graphql: { name: 'GraphQL', color: '#e10098' },
  gql: { name: 'GraphQL', color: '#e10098' },

  // Data / config / docs
  json: { name: 'JSON', color: '#292929' },
  yml: { name: 'YAML', color: '#cb171e' },
  yaml: { name: 'YAML', color: '#cb171e' },
  toml: { name: 'TOML', color: '#9c4221' },
  md: { name: 'Markdown', color: '#083fa1' },
  markdown: { name: 'Markdown', color: '#083fa1' },
  sql: { name: 'SQL', color: '#e38c00' },
};

/**
 * Exact (case-insensitive) file names that identify a language without
 * relying on an extension.
 */
const EXACT_FILENAME_LANGUAGES: Record<string, Language> = {
  dockerfile: { name: 'Dockerfile', color: '#384d54' },
  makefile: { name: 'Makefile', color: '#427819' },
};

/**
 * Generated/vendored lockfiles and similar noise: real code, but not a
 * meaningful signal for "what language is this repo written in" — a
 * TypeScript repo with one `package-lock.json` shouldn't read as JSON.
 * Matched as an exact (case-insensitive) basename.
 */
const IGNORED_FILENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
  'cargo.lock',
  'go.sum',
]);

/**
 * Languages GitHub's linguist classifies as `data` or `prose` (JSON, YAML,
 * TOML, Markdown, GraphQL schemas). They're real files, but linguist EXCLUDES
 * them from a repo's language statistics — so a TypeScript repo full of
 * `package.json` / `tsconfig.json` / README never reads as "JSON" or
 * "Markdown". We only ever surface one of these when a repo has NO
 * programming/markup language at all, and in that case we show no badge —
 * exactly like GitHub's empty language bar for a docs-only or config-only repo.
 */
const NON_PRIMARY_LANGUAGES = new Set(['JSON', 'YAML', 'TOML', 'Markdown', 'GraphQL']);

/** Last path segment, so callers may pass either bare names or full paths. */
function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Lowercased extension without the leading dot, or null for extension-less
 * names and dotfiles (e.g. `.gitignore`, whose "extension" would otherwise be
 * the whole name minus the leading dot — not a useful signal here).
 */
function extensionOf(fileName: string): string | null {
  const idx = fileName.lastIndexOf('.');
  if (idx <= 0) return null;
  return fileName.slice(idx + 1).toLowerCase();
}

/**
 * Count recognized extensions (and a few exact filenames like `Dockerfile`)
 * across the given file names, and return the most common PROGRAMMING/markup
 * language. `data`/`prose` languages (JSON, YAML, TOML, Markdown, GraphQL) are
 * counted but never chosen — they only ever describe a repo when it has no
 * real code, and there we prefer no badge (see {@link NON_PRIMARY_LANGUAGES}).
 *
 * Ties are broken deterministically by language name (ascending) so the
 * result is stable across calls/re-renders regardless of file-listing order.
 * Lockfiles and similar noise are excluded; unrecognized names are ignored.
 *
 * @returns the most common eligible {@link Language}, or null if none matched.
 */
export function pickPrimaryLanguage(fileNames: string[]): Language | null {
  const counts = new Map<string, { language: Language; count: number }>();

  for (const rawName of fileNames) {
    const name = basename(rawName);
    const lower = name.toLowerCase();
    if (IGNORED_FILENAMES.has(lower)) continue;

    let language: Language | undefined = EXACT_FILENAME_LANGUAGES[lower];
    if (!language) {
      const ext = extensionOf(name);
      if (!ext) continue;
      language = LANGUAGE_BY_EXT[ext];
    }
    if (!language) continue;

    const existing = counts.get(language.name);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(language.name, { language, count: 1 });
    }
  }

  let best: { language: Language; count: number } | null = null;
  for (const candidate of counts.values()) {
    // Skip data/prose languages — config and docs never win the badge.
    if (NON_PRIMARY_LANGUAGES.has(candidate.language.name)) continue;
    if (
      !best ||
      candidate.count > best.count ||
      (candidate.count === best.count && candidate.language.name < best.language.name)
    ) {
      best = candidate;
    }
  }

  return best ? best.language : null;
}
