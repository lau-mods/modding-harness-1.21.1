# Task specifications

`PROJECT.md` is the permanent project specification. Put a bounded task in `spec/tasks/<task-id>.md`, with nonempty `## Goal`, `## Included Acceptance Criteria`, `## Constraints`, and `## Non-goals` sections. List criteria as `- AC-ID`, referring to existing PROJECT criteria.

Write and commit the specification before starting from a clean project. Implementation agents cannot modify `spec/**`.

Run `node .harness/cli.mjs develop --task spec/tasks/<task-id>.md --plan-only`, inspect the reviewed plan, then `node .harness/cli.mjs develop --resume`. The harness creates local verified milestone commits and runs final regression. It never pushes.

See the shared [checkpoint workflow](../../.harness/docs/ai/CHECKPOINT_WORKFLOW.md) for resume, replan and recovery.
