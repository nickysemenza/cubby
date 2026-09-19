# Agent model and context routing

Use the cheapest model that can independently validate the task. Model names
and aliases are host/provider configuration, not product contracts; treat this
table as a routing recommendation and preserve an explicit user selection.

## Codex

| Task shape | Model | Reasoning |
| --- | --- | --- |
| Searches, logs, focused tests, mechanical edits | `gpt-5.6-luna` | low/medium |
| Bounded investigation or implementation | `gpt-5.6-terra` | medium |
| Bounded but difficult implementation | `gpt-5.6-terra` | high |
| Normal ambiguous Cubby work | `gpt-5.6-sol` | medium |
| Cross-layer debugging, contracts, or migrations | `gpt-5.6-sol` | high |
| Architecture, risky change, or adversarial review | `gpt-6-astra` | high |
| Unresolved invariants or competing migration explanations | `gpt-6-astra` | xhigh, selectively |

Start at the lowest suitable reasoning level and escalate when evidence conflicts,
the first attempt fails for a non-obvious reason, or the consequences justify
deeper analysis. Repository size alone is not an escalation signal.

## Claude Code

Use aliases so provider-specific versions can advance without repository edits:

| Task shape | Model |
| --- | --- |
| Searches, logs, mechanical edits | `haiku` |
| Bounded investigation or implementation | `sonnet` |
| Complex plan followed by implementation | `opusplan` |
| Difficult debugging, architecture, or migration review | `opus` |
| Very large, ambiguous, autonomous work | `fable`, when available |

`sonnet` is the normal Claude Code default. Use `opusplan` or `opus` when the
hard part is deciding the correct behavior, not merely editing many files.
Use `fable` only when the task needs unusually long autonomous investigation
and verification.

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
