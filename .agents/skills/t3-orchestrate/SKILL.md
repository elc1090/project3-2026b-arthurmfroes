---
name: t3-orchestrate
description: Orchestrate parallel implementation of the collaborative whiteboard T3 OpenSpec change with isolated worktrees, focused verification, review, and local integration.
---

# T3 orchestration

Use this skill when dispatching or continuing implementation of `collaborative-whiteboard-t3` in this repository. Read the current OpenSpec apply instructions and `tasks.md` before choosing work. The dependency table in `tasks.md` decides what is ready; task numbers are not a serial queue. Use the `openspec-apply-change` workflow for the implementation and progress tracker.

## Coordinator

1. Keep `main` as the integration branch. Inspect its status before creating worktrees. Local commits needed to establish a common base and integrate reviewed work are authorized by the user's orchestration request. Do not push or deploy unless separately requested.
2. Dispatch ready, independent tasks to agents using `gpt-6-luna` with `reasoning_effort: high`. Give each agent one named task or one tightly coupled task pair, an absolute worktree path on its own branch, file ownership, explicit acceptance criteria, and the relevant OpenSpec context. Never assign concurrent writes to the same shared module without agreeing on the interface first.
3. Ask agents to report after inspecting the task, when the approach is set, after implementation, and after focused verification. They should message the coordinator immediately when a dependency, ambiguity, or failing check changes the plan. Answer their questions from the specs and code; consult the user with `notify-send "Codex" ...` only if the answer requires a product decision the existing plan cannot settle.
4. Review every handoff yourself. Read the actual diff and touched code, check it against the task, its tests, adjacent module contracts, and product baseline. Run only the smallest additional check needed to resolve a concrete review risk. Ask the agent to fix gaps before integration.
5. Integrate accepted branches into local `main` one at a time. Resolve conflicts against the current OpenSpec tracker and verify the merged behavior. Mark a task complete only when its full acceptance criteria pass; report remaining cross-lane checks explicitly. Do not leave unreviewed agent work merged.
6. Send the user periodic commentary updates during work, including while agents are running. Each update names tasks integrated and verified, tasks being implemented or reviewed, what remains blocked or pending, and the next handoff. Send one after each integration or material change and at least once per 60 seconds of ongoing work. Notify with `notify-send "Codex"` when a long milestone finishes or a decision blocks progress.

## Worker brief to include with every dispatch

- Work only in the assigned worktree and branch. Read the OpenSpec task, design, relevant specs, and adjacent code before editing. Preserve all original whiteboard features in scope.
- Wrap **every terminal command** with GNU `timeout 120s`, for example `timeout 120s npm test -- --testNamePattern=...`. A timeout is a result to report, not a reason to repeat an idle command without diagnosis. Tool calls that edit files directly are not terminal commands.
- Run focused checks for the files and behavior changed. Do not run a whole test suite merely because it exists. If a task's acceptance criterion needs a broader integration check, tell the coordinator exactly what remains; do not mark the task complete prematurely.
- Send brief progress messages to the coordinator at inspection, implementation, verification, and handoff. State commands run and their results. Ask the coordinator when unsure; do not contact the user directly.
- Keep changes inside assigned ownership. Commit finished work on the task branch for local integration. Do not push, deploy, run a dev server for the user, or alter another task's checkbox. The coordinator reviews and reconciles `tasks.md` on `main`.

Use `notify-send "Codex"` for a blocker that needs the user's decision or for a long orchestration milestone. Report only what was actually verified.
