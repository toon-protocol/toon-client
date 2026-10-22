// The toon-plugins skill check (toon-client#752), driven against this package's own CLI from
// source: whatever `toon-client <command> --help` answers is what the check believes.

import { describe, it, expect } from 'vitest';
import { runCli } from '../../packages/client/src/cli/main.js';
import { checkSkills, type Cli } from './skill-check.js';

const cli = (version = '5.1.1'): Cli => ({
  version,
  async help(path) {
    const stderr: string[] = [];
    const exitCode = await runCli([...path, '--help'], {
      stdout: () => {},
      stderr: (text) => stderr.push(text),
    });
    return { exitCode, stderr: stderr.join('\n') };
  },
});

const skill = (body: string, range = '">=5.0.0, <6"') => ({
  path: 'plugins/toon-client/skills/sending/SKILL.md',
  text: `---\nname: sending\ntoon-client: ${range}\n---\n\n${body}\n`,
});

describe('checkSkills', () => {
  it('passes a skill whose commands all exist', async () => {
    const text = [
      'Ask the price with `toon-client price <route>`, then pay:',
      '',
      '```bash',
      'toon-client channel open --deposit 100000',
      'toon-client send g.toon.echo --body hi',
      '```',
    ].join('\n');
    expect(await checkSkills([skill(text)], cli())).toEqual([]);
  });

  it('fails a skill that names a command the CLI does not have', async () => {
    const problems = await checkSkills(
      [skill('Run `toon-client frobnicate --now`.')],
      cli()
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('`toon-client frobnicate` is not a command');
  });

  it('fails a skill that names a channel subcommand the CLI does not have', async () => {
    const problems = await checkSkills(
      [skill('Run `toon-client channel refill 5000`.')],
      cli()
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      '`toon-client channel refill` is not a command'
    );
  });

  it('fails a skill that names the old binary, `toon`, in a span or on a line', async () => {
    const text = [
      'Pay with `toon send <route>`.',
      '',
      '```bash',
      'toon channel open',
      '```',
    ].join('\n');
    const problems = await checkSkills([skill(text)], cli());
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(
      "`toon send` names the old binary; this package's is `toon-client`"
    );
    expect(problems[1]).toContain('`toon channel open` names the old binary');
  });

  it("reads the version range from the skill's frontmatter", async () => {
    const body = 'Run `toon-client balances`.';
    expect(
      await checkSkills([skill(body, '">=5.0.0, <6"')], cli('5.1.1'))
    ).toEqual([]);
    expect(
      await checkSkills([skill(body, '">=5.2.0, <6"')], cli('5.1.1'))
    ).toEqual([
      'plugins/toon-client/skills/sending/SKILL.md: this package is 5.1.1, outside the skill\'s toon-client range ">=5.2.0, <6"',
    ]);
    const [major] = await checkSkills([skill(body)], cli('6.0.0'));
    expect(major).toContain(
      '6.0.0, outside the skill\'s toon-client range ">=5.0.0, <6"'
    );
  });

  it('fails a SKILL.md with no toon-client range, but asks no reference file for one', async () => {
    const bare = {
      path: 'skills/sending/SKILL.md',
      text: '---\nname: sending\n---\n\nHello.\n',
    };
    const reference = {
      path: 'skills/sending/references/channels.md',
      text: 'Run `toon-client channel status`.',
    };
    expect(await checkSkills([bare, reference], cli())).toEqual([
      'skills/sending/SKILL.md: its frontmatter has no `toon-client` version range',
    ]);
  });
});
