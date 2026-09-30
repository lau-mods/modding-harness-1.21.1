# NeoForge system project

Minecraft Java 1.21.1 / NeoForge / ModDevGradle / Java 21.

Gradle, `src/`, `spec/`, scenarios and `AGENTS.md` belong to this project. The shared development runtime is the pinned `.harness` Git submodule.

```sh
git submodule update --init --recursive
npm --prefix .harness ci --ignore-scripts
node .harness/cli.mjs doctor
node .harness/cli.mjs validate --build
```

Write and agree the specification in [spec/PROJECT.md](spec/PROJECT.md) before running `node .harness/cli.mjs develop`. The initial specification is intentionally a draft. See the [harness README](.harness/README.md) for setup, runtime preparation, workflows and explicit version updates.

The MDK license is in [TEMPLATE_LICENSE.txt](TEMPLATE_LICENSE.txt). Choose your Mod's distribution license in its specification and Gradle metadata.
