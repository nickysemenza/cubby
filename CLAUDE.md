# Cubby agent rules

## Universal loop

- Make the requested in-scope change; validate at the narrowest tier that can
  fail. `pnpm typecheck` is cheap. At handoff, run `pnpm check` plus affected
  tests; before a PR, run the existing full relevant gates.
- One agent owns each validation command. Others continue useful work while it
  runs, return distilled evidence (result, command, duration, relevant output),
  and the root performs one bounded final join rather than polling.
- Production migrations have one exclusive owner; establish safe data and
  deployed-code compatibility before pushing, then verify the schema afterward.
- Keep edits disjoint across agents/worktrees. The main task uses the configured
  Sol/high or Opus/high default. Route bounded implementation, investigation,
  test, and log-analysis subagents to Terra/medium or Sonnet/medium; use another
  frontier agent only for independent review of broad or risky work.
- Public text and fixtures contain no real household or production data. Use
  placeholders; internal shortcodes are safe.
- Comments preserve constraints, regressions, contracts, and active TODOs—not
  narration. Do not weaken guard-backed tests as apparent duplication.

## Product constraints

The [README tenets](README.md#tenets) are binding: inventory never
auto-decrements; `fdc_id` is product-only; rare interactive work stays
interactive; all money is `SUM(Expense.cost)`; the trusted household has no
multi-user coordination, restore/undo, reservations, or locking. Read only the
relevant README heading for architecture, commands, entities, deployment, or
roadmap context.

## Load when triggered

- **Test choice, CI, PR, or validation:** [agent validation](docs/agents/validation.md).
- **Schema, migration, delete/merge, identifiers, repo/service boundary, WASM,
  or Workers:** [agent domain rules](docs/agents/domain-rules.md).
- **React, routes, browser behavior, styling, images, tables, or web UI:**
  [apps/web/CLAUDE.md](apps/web/CLAUDE.md). For visual/design choices, also read
  [DESIGN.md](apps/web/DESIGN.md).

Open PRs ready for review unless the work is intentionally incomplete or the
user asks for a draft.
