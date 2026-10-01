# NeoForge system project

Minecraft Java 1.21.1 / NeoForge / ModDevGradle / Java 21.

Gradle, `src/`, `spec/PROJECT.md`, scenarios and `AGENTS.md` belong to this project. The shared development runtime is the pinned `.harness` Git submodule.

```sh
git submodule update --init --recursive
npm --prefix .harness ci --ignore-scripts
node .harness/cli.mjs doctor
```

Write observable requirements in [spec/PROJECT.md](spec/PROJECT.md), replace the draft placeholder, then run `node .harness/cli.mjs develop`. You do not need task files, AC IDs, a verification table or milestone files. The Harness plans the work and creates local verified commits; it never pushes. See the [Harness README](.harness/README.md) for setup and runtime details.

The MDK license is in [TEMPLATE_LICENSE.txt](TEMPLATE_LICENSE.txt). Choose your Mod's distribution license in PROJECT.md and Gradle metadata.
