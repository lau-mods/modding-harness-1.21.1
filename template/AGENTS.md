# Project development

Target Minecraft Java 1.21.1, NeoForge, ModDevGradle, Java 21. Preserve the client, server, gameTestServer and data runs.

`spec/PROJECT.md` defines this project's accepted scope. Implement its observable criteria and respect Non-goals; do not invent a project from the draft placeholder.

Follow the shared [harness agent policy](.harness/docs/ai/AGENT_POLICY.md). Only the harness manages Minecraft lifecycle. For local validation run `node .harness/cli.mjs validate`; use `node .harness/cli.mjs develop` for the gated workflow.

This file belongs to this project. Add project-specific instructions here; updating `.harness` does not overwrite them.
