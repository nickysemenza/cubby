# Agent model and context routing

Use the cheapest model that can independently validate the task. Provider names
and aliases are host configuration, not repository contracts. Start with a
fast model for searches, logs, focused tests, and mechanical edits; use a
capable model for bounded implementation; reserve the strongest available model
for architecture, migrations, competing evidence, or independent adversarial
review. Escalate when evidence conflicts or the first attempt fails for a
non-obvious reason, not merely because the repository is large. Preserve an
explicit user model selection.

## Delegation and context

- Delegate only independent, bounded work that materially advances the task.
- Give each subagent exact scope, owned files, allowed commands, exclusions,
  and a compact evidence-return format.
- Keep architecture decisions, migration ownership, full verification, and
  final integration with the main agent.
- Let one agent own each expensive gate; do not repeat full typecheck, test,
  database, E2E, or Apple gates in parallel.
- Prefer targeted search, file regions, diffs, test output, and page text over
  whole-file dumps or screenshots.
- Have delegated work return the result, commands, duration, relevant output,
  and limitations rather than a transcript.

## Cubby application models

`typesafe/jev`, `claude-sonnet-5`, and `claude-haiku-4-5` are Cubby runtime
models. They are not Codex or Claude Code agent-routing choices.
