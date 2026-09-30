# Harness maintenance

This repository owns the shared runtime. System projects consume it as a pinned `.harness` Git submodule; `template/` supplies initial project files only.

For harness maintenance read [CODE_QUALITY](docs/ai/CODE_QUALITY.md), [TESTING_POLICY](docs/ai/TESTING_POLICY.md), and [architecture](docs/ai/HARNESS_ARCHITECTURE.md). Preserve existing command behavior, user changes, and dependency versions. Use normal file moves and refactoring, never rewrite history or automatically commit.

Codex Sol implements; subscription-authenticated Claude Opus independently reviews a curated snapshot, read-only. Exchange structured findings and test results, never conversation transcripts. Run `npm test` and the applicable static/build checks. Only the harness manages Minecraft lifecycle; do not launch a client/server as part of ordinary code iteration.

The system development policy lives in [AGENT_POLICY](docs/ai/AGENT_POLICY.md). It is separate from each system's project-owned `AGENTS.md`. Never overwrite generated project files on a harness update. Do not read credentials, change global agent configuration, install global packages, delete worlds, reset user changes, or force push.
