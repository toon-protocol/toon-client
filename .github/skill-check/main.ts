// CI entry for the toon-plugins skill check (toon-client#752):
//
//   npx tsx .github/skill-check/main.ts <toon-plugins checkout>
//
// Reads every Markdown file under the checkout's `plugins/toon-client/skills/` and checks it
// against the CLI this repo just built (`packages/client/dist/cli/main.js`). Exits 1 on any
// problem, and when the plugin is not where it should be.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSkills, type Skill } from './skill-check.js';

const repo = resolve(fileURLToPath(import.meta.url), '../../..');
const bin = join(repo, 'packages/client/dist/cli/main.js');
const { version } = JSON.parse(
  readFileSync(join(repo, 'packages/client/package.json'), 'utf8')
) as {
  version: string;
};

const checkout = process.argv[2];
if (checkout === undefined) {
  console.error('usage: main.ts <toon-plugins checkout>');
  process.exit(2);
}
const skillsDir = resolve(checkout, 'plugins/toon-client/skills');
if (!existsSync(skillsDir)) {
  console.error(
    `::error::no ${relative(process.cwd(), skillsDir)}: toon-plugins has moved the toon-client plugin`
  );
  process.exit(1);
}
if (!existsSync(bin)) {
  console.error(`::error::no ${bin}: build the client first`);
  process.exit(1);
}

const skills: Skill[] = readdirSync(skillsDir, {
  recursive: true,
  encoding: 'utf8',
})
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => ({
    path: relative(checkout, join(skillsDir, name)),
    text: readFileSync(join(skillsDir, name), 'utf8'),
  }));
if (skills.length === 0) {
  // Until toon-plugins#4 lands, the plugin is an empty skills directory: nothing to check yet.
  console.log(
    `toon-plugins has no toon-client skills yet; nothing to check against ${version}.`
  );
  process.exit(0);
}

const problems = await checkSkills(skills, {
  version,
  async help(path) {
    const run = spawnSync(process.execPath, [bin, ...path, '--help'], {
      encoding: 'utf8',
    });
    return { exitCode: run.status ?? 1, stderr: run.stderr };
  },
});
for (const problem of problems) console.error(`::error::${problem}`);
if (problems.length > 0) {
  console.error(
    `\n${String(problems.length)} problem(s). A red here means this repo moved: land the matching ` +
      'skill change in toon-plugins first.'
  );
  process.exit(1);
}
console.log(
  `${String(skills.length)} toon-client skill file(s) agree with toon-client ${version}.`
);
