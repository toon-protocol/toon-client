// Does every skill in toon-plugins' `toon-client` plugin still describe this package's CLI?
// (toon-client#752)
//
// A skill names a command the way toon_cli's `tests/skill.rs` (`named_commands`) reads one: an
// inline code span that starts with `toon-client `, or a line that starts with it. The command is
// the leading plain words; a `<placeholder>`, a value or a `--flag` ends it. Each command is
// asked for `--help`, which must exit 0: the CLI is the list, so nothing here hard-codes one.

/** One skill file: its path for the report, and its text. */
export interface Skill {
  path: string;
  text: string;
}

/** The CLI under check. */
export interface Cli {
  /** This package's version. */
  version: string;
  /** Run `toon-client <path…> --help`. */
  help(path: string[]): Promise<{ exitCode: number; stderr: string }>;
}

/**
 * Each place a skill names a command, as its binary and the words after it.
 *
 * `toon` is collected as well as `toon-client`. It was this package's binary before 5.0 (#739)
 * and is now toon_cli's, whose commands differ, so in a `toon-client` skill it is always a
 * mistake.
 */
function namedCommands(text: string): { binary: string; words: string[] }[] {
  const spans = text.split('`').filter((_, i) => i % 2 === 1);
  const lines = text.split('\n').map((line) => line.trimStart());
  return [...spans, ...lines].flatMap((named) => {
    const [binary, ...words] = named.split(/\s+/).filter(Boolean);
    return (binary === 'toon-client' || binary === 'toon') &&
      named.startsWith(`${binary} `)
      ? [{ binary, words }]
      : [];
  });
}

/** The command's own words: the plain ones before any placeholder, value or flag. */
function commandPath(words: string[]): string[] {
  const path: string[] = [];
  for (const word of words) {
    if (!/^[a-z][a-z-]*$/.test(word)) break;
    path.push(word);
  }
  return path;
}

/** A SKILL.md's `toon-client:` frontmatter value, unquoted; `undefined` when it has none. */
function frontmatterRange(text: string): string | undefined {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const value = /^toon-client:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
  return value?.replace(/^(["'])(.*)\1$/, '$2');
}

/** `5`, `5.1` or `5.1.1` as three numbers, the missing ones 0; `undefined` if it is none of those. */
function versionParts(version: string): number[] | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(version);
  return match?.slice(1).map((part) => Number(part ?? 0));
}

/**
 * Does `version` fall inside `range`? A range is comparators joined by commas, Cargo-style,
 * e.g. `>=5.0.0, <6`. `undefined` when the range cannot be read.
 */
function inRange(version: string, range: string): boolean | undefined {
  const have = versionParts(version);
  if (have === undefined) return undefined;
  const results = range.split(',').map((comparator) => {
    const match = /^\s*(>=|<=|>|<|=)?\s*(\S+)\s*$/.exec(comparator);
    const want = match ? versionParts(match[2] as string) : undefined;
    if (!match || want === undefined) return undefined;
    const i = have.findIndex((part, n) => part !== want[n]);
    const order =
      i === -1 ? 0 : Math.sign((have[i] as number) - (want[i] as number));
    switch (match[1] ?? '=') {
      case '>=':
        return order >= 0;
      case '<=':
        return order <= 0;
      case '>':
        return order > 0;
      case '<':
        return order < 0;
      default:
        return order === 0;
    }
  });
  return results.includes(undefined) ? undefined : results.every(Boolean);
}

/** Every way the skills have drifted from the CLI, one line each; empty when they agree. */
export async function checkSkills(
  skills: Skill[],
  cli: Cli
): Promise<string[]> {
  const problems: string[] = [];
  const asked = new Set<string>();
  for (const { path, text } of skills) {
    if (path === 'SKILL.md' || path.endsWith('/SKILL.md')) {
      const range = frontmatterRange(text);
      const fits =
        range === undefined ? undefined : inRange(cli.version, range);
      if (range === undefined) {
        problems.push(
          `${path}: its frontmatter has no \`toon-client\` version range`
        );
      } else if (fits === undefined) {
        problems.push(`${path}: cannot read its toon-client range "${range}"`);
      } else if (!fits) {
        problems.push(
          `${path}: this package is ${cli.version}, outside the skill's toon-client range "${range}"`
        );
      }
    }
    for (const { binary, words } of namedCommands(text)) {
      const command = commandPath(words);
      const key = command.join(' ');
      if (binary === 'toon') {
        problems.push(
          `${path}: \`toon ${key}\` names the old binary; this package's is \`toon-client\``
        );
        continue;
      }
      if (asked.has(key)) continue;
      asked.add(key);
      const help = await cli.help(command);
      if (help.exitCode !== 0) {
        problems.push(
          `${path}: \`toon-client ${key}\` is not a command: ${help.stderr.split('\n')[0]}`
        );
      }
    }
  }
  return problems;
}
