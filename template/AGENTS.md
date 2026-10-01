# Project development

Target Minecraft Java 1.21.1, NeoForge, ModDevGradle, Java 21. Preserve the client, server, gameTestServer and data runs.

`spec/PROJECT.md` is this project's sole developer-maintained product specification. Implement its observable requirements and respect Non-goals. Do not invent behavior from a draft placeholder. Derived features, tasks, ACs and milestones are Harness-managed and cannot override PROJECT.md.

Follow the shared [Harness agent policy](.harness/docs/ai/AGENT_POLICY.md). Only the Harness manages Minecraft lifecycle. For local validation run `node .harness/cli.mjs validate`; use `node .harness/cli.mjs develop` for the gated workflow.

This file belongs to this project. Add project-specific instructions here; updating `.harness` does not overwrite it.
