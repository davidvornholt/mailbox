# pim, compiled the same way as `bun run install:user`, with its agent skills
# in share/pim/skills/<skill>/SKILL.md.
#
# The node_modules hash below changes whenever bun.lock or the Bun version
# changes. Then `nix build .#default` fails and prints the expected value
# after "got:"; put that value in outputHash.
{
  bun,
  lastModifiedDate,
  lib,
  stdenvNoCC,
}:
let
  pname = "pim";
  # pim has no releases, so the version is the date of the commit, taken from
  # the flake's lastModifiedDate (YYYYMMDDHHMMSS).
  datePart = start: length: builtins.substring start length lastModifiedDate;
  version = "0-unstable-${datePart 0 4}-${datePart 4 2}-${datePart 6 2}";
  # Leave out what local installs and builds create, for when the flake is
  # read from a plain path; a git checkout already leaves out ignored files.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.difference ../. (
      lib.fileset.unions (
        map lib.fileset.maybeMissing [
          ../.direnv
          ../.git
          ../.turbo
          ../node_modules
          ../result
          ../apps/cli/.turbo
          ../apps/cli/dist
          ../apps/cli/node_modules
          ../packages/a11y-testing/.turbo
          ../packages/a11y-testing/node_modules
          ../packages/typescript-config/.turbo
          ../packages/typescript-config/node_modules
        ]
      )
    );
  };
  skills = builtins.attrNames (
    lib.filterAttrs (_name: type: type == "directory") (builtins.readDir ../apps/cli/skills)
  );
  # The CLI's runtime dependencies only; the compiled binary bundles them.
  # Bun's version is part of the name, so a Bun update checks the hash against
  # the layout that Bun installs instead of reusing the old output.
  nodeModules = stdenvNoCC.mkDerivation {
    pname = "${pname}-node-modules-bun-${bun.version}";
    inherit version src;
    nativeBuildInputs = [ bun ];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
      bun install --frozen-lockfile --production --ignore-scripts --no-progress
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir "$out"
      find . -type d -name node_modules -prune -print0 | tar --null --files-from=- -cf - | tar -C "$out" -xf -
      runHook postInstall
    '';
    dontFixup = true;
    outputHash = "sha256-89uauv3E4OQfEt1Zign+XG3UF1Am6KjwhzPR4t2W7Cs=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    impureEnvVars = lib.fetchers.proxyImpureEnvVars;
  };
in
stdenvNoCC.mkDerivation {
  inherit pname version src;
  nativeBuildInputs = [ bun ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    cp -r --no-preserve=mode ${nodeModules}/. .
    cd apps/cli
    bun build --compile src/app/cli.ts --outfile dist/pim
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 dist/pim "$out/bin/pim"
    for skill in ${lib.escapeShellArgs skills}; do
      install -Dm444 "skills/$skill/SKILL.md" "$out/share/pim/skills/$skill/SKILL.md"
    done
    runHook postInstall
  '';
  # Bun appends the bundled program to its own executable; leave it intact.
  dontStrip = true;
  dontPatchELF = true;

  passthru = { inherit nodeModules skills; };
  meta = {
    description = "Command line interface for mail, calendars, and contacts";
    homepage = "https://github.com/davidvornholt/pim";
    license = lib.licenses.mit;
    platforms = [
      "aarch64-linux"
      "x86_64-linux"
    ];
    mainProgram = "pim";
  };
}
