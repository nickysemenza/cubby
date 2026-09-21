---
name: cubby-pr-ci-maintenance
description: Inspect and repair Cubby PR checks or address review feedback. Use for failing CI, requested PR fixes, or monitoring an existing PR through completion.
---

# Cubby PR and CI maintenance

This skill owns triage and delivery sequencing. Follow [Cubby agent
rules](../../../AGENTS.md) and [validation, CI, and delivery](../../../docs/agents/validation.md)
for current commands, cheap Git operations, and local versus hosted gates.

## Procedure

1. Resolve the repository, PR, head commit, base, configured checkout, and
   requested scope from the current session. Inspect live PR metadata and check
   results before editing; `gh pr view` and `gh pr checks` provide the initial
   evidence.
2. Read failed annotations and relevant logs. Classify failures as caused by the
   PR, pre-existing, missing local setup, or external infrastructure. Pending
   checks alone do not justify a patch. Compare with the base when causality is
   unclear.
3. If review feedback is in scope, inspect unresolved threads separately from
   CI and verify each concern against the current head. A green check does not
   establish that requested feedback has been addressed; an old unresolved
   comment does not establish a current bug.
4. Make the smallest causal repair within the authorized scope. Use an isolated
   worktree when the configured checkout must stay untouched. Establish the
   documented local setup before treating missing dependencies or build
   artifacts as application failures.
5. Run the failed gate and affected checks according to the validation guide.
   Distinguish fixed failures from unrelated failures and unavailable checks.
   Read `apps/web/.vitest-failures.txt` instead of repeating a failed tier.
   Choose local checks for the changed behavior and reuse valid results;
   publication and handoff do not require a broad local validation run.
6. When publication is requested, commit and push the scoped changes following
   the validation policy. Require passing GitHub checks on the exact final PR
   head before merge; if hosted verification is requested, wait for results on
   that commit. Report local and hosted evidence separately.
7. When monitoring is requested, use the host's supported automation and update
   an existing matching monitor where possible. Keep it quiet while the state
   is unchanged; otherwise use one bounded wait instead of repeatedly streaming
   the same check state. Notify on a meaningful result or required action.
   Verify the requested completion condition before closing the matching
   monitor. Merge only when the user has requested it.

## Handoff

Report the PR URL and final head, changes made, validation results, outstanding
review items, unrelated or pending failures, and working-tree state. Preserve
uncertainty when a check has not run or has not finished.
