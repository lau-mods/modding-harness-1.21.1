# AI Mod development

Target Minecraft Java 1.21.1, NeoForge, ModDevGradle, Java 21. Preserve the MDK's client, server, gameTestServer and data runs. `spec/PROJECT.md` is the accepted scope; implement observable criteria and respect Non-goals. Do not turn its draft placeholder into an invented project.

Codex Sol implements. Claude Opus independently reviews code and visual evidence, read-only. Exchange structured findings/test results, never conversation transcripts.

`spec/**` is user-owned input and read-only during implementation. Implement only the current milestone's goal and ACs; honor excludedScope and do not prebuild later milestones. Never run git commit, push, reset, rebase, checkout, stash or merge, or change Git metadata/index. The harness alone creates verified local commits when the user invokes checkpoint development. See [checkpoint workflow](CHECKPOINT_WORKFLOW.md).

Read only the policy relevant to the task:

- Code/design: [CODE_QUALITY](CODE_QUALITY.md).
- Tests: [TESTING_POLICY](TESTING_POLICY.md).
- Visual changes: [VISUAL_TESTING](VISUAL_TESTING.md).
- Ambiguous specifications: [SPEC_WRITING](SPEC_WRITING.md).

Run safe local static validation and Gradle compile/build/unit tests without asking. During a harness-managed implementation session, use `validate --agent-fast`; harness self-tests run in the separate validation gate or during explicit harness maintenance. Do not run them inside the implementation session. The harness alone manages Minecraft lifecycle: implementers must never start a client, server, GameTest server, or MC Pilot lifecycle command. Prepare scenarios and wait for the harness gates.

Do not edit the harness during Mod development, including when fixing failures. Report a blocker if it needs changes; harness maintenance is a separate, explicitly requested task.

Use the sequence specification → implementation → static/resource checks → compile/test → code review → fixes → build → applicable GameTest → batched E2E → visual review. Finish a candidate before booting Minecraft. Prefer resource reload when safe; Java/registry/network changes require restart. Never use the client as a debugger for ordinary code iteration.

Preserve user changes. No destructive reset/checkout, force push, automatic commit/branch deletion, world deletion, public-server automation, credentials in files/logs, global package installation, or global agent configuration changes. Do not access credentials directly; use subscription-authenticated CLIs. Prefer fewer concepts and direct APIs over speculative abstraction.
