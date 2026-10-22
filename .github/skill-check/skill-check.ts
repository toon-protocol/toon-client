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
  /** Run `toon-client <command…> --help`. */
  help(command: string[]): Promise<{ exitCode: number; stderr: string }>;
}

/**
 * Each place a skill names a command, as its binary and the words after it.
 *
 * `toon` is collected as well as `toon-client`. It was this package's binary before 5.0 (#739)
 * and is now toon_cli's, whose commands differ.
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
function commandWords(words: string[]): string[] {
  const command: string[] = [];
  for (const word of words) {
    if (!/^[a-z][a-z-]*$/.test(word)) break;
    command.push(word);
  }
  return command;
}

/** A SKILL.md's `toon-client:` frontmatter value, unquoted; `undefined` when it has none. */
function frontmatterRange(text: string): string | undefined {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const value = /^toon-client:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
  return value?.replace(/^(["'])(.*)\1$/, '$2');
}

/**
 * `5`, `5.1` or `5.1.1` as three numbers, the missing ones 0; `undefined` if it is none of those.
 * A prerelease or build suffix is dropped, so `5.2.0-next.0` counts as `5.2.0`.
 */
function versionParts(version: string): number[] | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(version);
  return match?.slice(1).map((part) => Number(part ?? 0));
}

/** Is `have` on the side of `want` that `operator` asks for? */
function compare(have: number[], operator: string, want: number[]): boolean {
  const i = have.findIndex((part, n) => part !== want[n]);
  const order = i === -1 ? 0 : Math.sign((have[i] ?? 0) - (want[i] ?? 0));
  switch (operator) {
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
}

/**
 * Does `version` fall inside `range`? A range is comparators joined by commas (Cargo) or spaces
 * (npm), e.g. `>=5.0.0, <6`. `undefined` when the range cannot be read.
 */
function inRange(version: string, range: string): boolean | undefined {
  const have = versionParts(version);
  const comparators = range
    .split(/[\s,]+/)
    .join(' ')
    .replace(/(>=|<=|>|<|=) /g, '$1')
    .split(' ')
    .filter(Boolean)
    .map((comparator) => /^(>=|<=|>|<|=)?(.+)$/.exec(comparator));
  const fits = comparators.map((match) => {
    const want = match ? versionParts(match[2] ?? '') : undefined;
    return have === undefined || want === undefined
      ? undefined
      : compare(have, match?.[1] ?? '=', want);
  });
  if (fits.length === 0 || fits.includes(undefined)) return undefined;
  return fits.every(Boolean);
}

/** What is wrong with a SKILL.md's `toon-client` range, if anything. */
function rangeProblem(
  path: string,
  text: string,
  version: string
): string | undefined {
  const range = frontmatterRange(text);
  if (range === undefined)
    return `${path}: its frontmatter has no \`toon-client\` version range`;
  const fits = inRange(version, range);
  if (fits === undefined)
    return `${path}: cannot read its toon-client range "${range}"`;
  if (!fits) {
    return `${path}: this package is ${version}, outside the skill's toon-client range "${range}"`;
  }
  return undefined;
}

/** Every way the skills have drifted from the CLI, one line each; empty when they agree. */
export async function checkSkills(
  skills: Skill[],
  cli: Cli
): Promise<string[]> {
  const problems: string[] = [];
  // One `--help` per command, however many files name it; each file is still reported.
  const asked = new Map<string, ReturnType<Cli['help']>>();
  const help = (command: string[]) => {
    const key = command.join(' ');
    const answer = asked.get(key) ?? cli.help(command);
    asked.set(key, answer);
    return answer;
  };
  for (const skill of skills) {
    const { path } = skill;
    const text = skill.text.replace(/\r\n/g, '\n');
    if (path === 'SKILL.md' || path.endsWith('/SKILL.md')) {
      const problem = rangeProblem(path, text, cli.version);
      if (problem !== undefined) problems.push(problem);
    }
    for (const { binary, words } of namedCommands(text)) {
      const command = commandWords(words);
      const answer = await help(command);
      const named = command.join(' ');
      if (binary === 'toon') {
        // Only when the words are a `toon-client` command: that is the old name for it. Prose
        // that starts a line with "toon", or a real toon_cli command, is left alone.
        if (command.length > 0 && answer.exitCode === 0) {
          problems.push(
            `${path}: \`toon ${named}\` names the old binary; this package's is \`toon-client\``
          );
        }
      } else if (answer.exitCode !== 0) {
        problems.push(
          `${path}: \`toon-client ${named}\` is not a command: ${answer.stderr.split('\n')[0]}`
        );
      }
    }
  }
  return problems;
}
