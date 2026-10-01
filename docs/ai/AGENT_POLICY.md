# AI Mod development

Target Minecraft Java 1.21.1, NeoForge, ModDevGradle, Java 21. Preserve the MDK client, server, gameTestServer and data runs. `spec/PROJECT.md` is the sole developer-owned product specification. Implement observable behavior and respect Non-goals. Do not invent a project from its draft placeholder.

Codex Sol implements. Claude Opus independently reviews the derived specification, plan, code and visual evidence, read-only. Exchange structured findings and test results, never conversation transcripts. Derived features, requirements, ACs, tasks and plans are Harness-managed. PROJECT.md wins whenever a derived artifact conflicts with it.

`spec/**` is read-only during implementation. Implement only the current milestone's goal and ACs; honor excludedScope and do not prebuild later milestones. Never run git commit, push, reset, rebase, checkout, stash or merge, or change Git metadata/index. The Harness alone creates verified local commits. See [checkpoint workflow](CHECKPOINT_WORKFLOW.md).

Read only policy relevant to the task:

- Code/design: [CODE_QUALITY](CODE_QUALITY.md).
- Tests: [TESTING_POLICY](TESTING_POLICY.md).
- Visual changes: [VISUAL_TESTING](VISUAL_TESTING.md).
- Ambiguous specifications: [SPEC_WRITING](SPEC_WRITING.md).

Run safe local static validation and Gradle compile/build/unit tests without asking. During a Harness-managed implementation session, use `validate --agent-fast`; Harness self-tests run in a separate gate. The Harness alone manages Minecraft lifecycle. Implementers must never start a client, server, GameTest server or MC Pilot lifecycle command. Prepare scenarios and wait for Harness gates.

Preserve user changes. Do not perform destructive Git operations, delete worlds, automate public servers, read credentials, write credentials to files/logs, install global packages, or change global agent configuration. Use subscription-authenticated CLIs, not API keys. Prefer fewer concepts and direct APIs over speculative abstraction.
