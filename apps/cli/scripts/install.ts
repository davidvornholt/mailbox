// Installs the compiled pim command and its agent skills for the current user.
// Run through `bun run install:user`, which builds dist/pim first.

const home = Bun.env.HOME;
if (home === undefined || home === '') {
  throw new Error('HOME is not set');
}
const binDir = `${home}/.local/bin`;
const skillsDir = `${home}/.agents/skills`;
const appDir = `${import.meta.dir}/..`;
const skills = [...new Bun.Glob('*/SKILL.md').scanSync(`${appDir}/skills`)].map(
  (path) => path.split('/')[0] ?? path,
);

// Install beside the target and rename over it, so a running pim is never left
// with a half-written binary.
await Bun.$`mkdir -p ${binDir}`;
await Bun.$`install -m 755 ${appDir}/dist/pim ${binDir}/.pim.tmp`;
await Bun.$`mv -f ${binDir}/.pim.tmp ${binDir}/pim`;
await Promise.all(
  skills.map(
    (skill) =>
      Bun.$`install -D -m 644 ${appDir}/skills/${skill}/SKILL.md ${skillsDir}/${skill}/SKILL.md`,
  ),
);

// ~/.agents/skills may be its own git repository; keep the installed skills
// out of its status.
const gitDir = await Bun.$`git -C ${skillsDir} rev-parse --absolute-git-dir`
  .quiet()
  .nothrow();
if (gitDir.exitCode === 0) {
  const exclude = Bun.file(`${gitDir.text().trim()}/info/exclude`);
  const current = (await exclude.exists()) ? await exclude.text() : '';
  const lines = current.split('\n');
  const missing = skills
    .map((skill) => `/${skill}/`)
    .filter((line) => !lines.includes(line));
  if (missing.length > 0) {
    await Bun.write(
      exclude,
      `${current.trimEnd()}\n${missing.join('\n')}\n`.trimStart(),
    );
  }
}

await Bun.write(
  Bun.stdout,
  `Installed ${binDir}/pim and the skills ${skills.join(', ')} in ${skillsDir}\n`,
);
