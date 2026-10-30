// Installs the compiled pim command and its agent skills for the current user.
// Run through `bun run install:user`, which builds dist/pim first.
import { copyFile, mkdir, readdir, rename } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { delimiter, join, relative } from 'node:path';

const binDir = join(homedir(), '.local', 'bin');
const skillsDir = join(homedir(), '.agents', 'skills');
const appDir = join(import.meta.dir, '..');
// bun build --compile adds .exe to the output file on Windows.
const binary = platform() === 'win32' ? 'pim.exe' : 'pim';
const skills = (await readdir(join(appDir, 'skills'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

// Copy beside the target and rename over it, so a running pim is never left
// with a half-written binary. The copy keeps the build's executable mode.
await mkdir(binDir, { recursive: true });
const temporary = join(binDir, `.${binary}.tmp`);
await copyFile(join(appDir, 'dist', binary), temporary);
await rename(temporary, join(binDir, binary));
await Promise.all(
  skills.map(async (skill) => {
    await mkdir(join(skillsDir, skill), { recursive: true });
    await copyFile(
      join(appDir, 'skills', skill, 'SKILL.md'),
      join(skillsDir, skill, 'SKILL.md'),
    );
  }),
);

await Bun.write(
  Bun.stdout,
  `Installed ${join(binDir, binary)} and the skills ${skills.join(', ')} in ${skillsDir}\n`,
);
// path.relative compares case-insensitively on Windows, where PATH entries
// often differ from the home directory in case.
const onPath = (Bun.env.PATH ?? '')
  .split(delimiter)
  .some((entry) => entry !== '' && relative(entry, binDir) === '');
if (!onPath) {
  await Bun.write(Bun.stdout, `Add ${binDir} to your PATH to run pim.\n`);
}
