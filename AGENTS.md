# Cubby agent rules

## Universal loop

- Make the requested in-scope change; validate at the narrowest tier that can
  fail. `pnpm typecheck` is cheap. Run one file with `pnpm test:file src/…`
  (path relative to `apps/web`) — that is the spelling, not `vitest`/`npx
  vitest`. At handoff, run `pnpm check` plus affected tests; before a PR, run
  the existing full relevant gates.
- A failing test run already lists what failed, at the end of its output and in
  `apps/web/.vitest-failures.txt`. Read those instead of re-running the tier —
  measured, 24% of all test runs were a re-run of one that had just failed.
- Subagents run `pnpm test:file` only; `pnpm typecheck`, `pnpm check`, `pnpm
  test`, and Apple builds belong to the root's single final join, never to
  parallel implementers. Others continue useful work while the owner runs,
  return distilled evidence (result, command, duration, relevant output), and
  the root performs one bounded final join rather than polling.
- Production migrations have one exclusive owner; establish safe data and
  deployed-code compatibility before pushing, then verify the schema afterward.
- Keep edits disjoint across agents/worktrees. The main task runs on whichever
  frontier model the session selected — no model is pinned per-repo, so pick the
  cheaper tier for routine work rather than fighting a default. Route bounded
  implementation, investigation, test, and log-analysis subagents to the cheaper
  tier; use another frontier agent only for independent review of broad or risky
  work.
- Public text and fixtures contain no real household or production data. Use
  placeholders; internal shortcodes are safe.
- Comments preserve constraints, regressions, contracts, and active TODOs—not
  narration.
- A test earns its place by failing on a behavior regression the type system
  cannot catch. Delete tests that only prove existence, exercise a mock, or
  restate a typecheck; consolidate same-shape per-entity tests into one
  table-driven test. A test that names a regression or invariant in a comment
  is consolidated, never dropped.
- Git hooks are mandatory validation. Never use `--no-verify`; fix the failing
  pre-commit or scoped pre-push gate before committing or pushing.
- Before merge, verify the exact final commit locally with `pnpm verify:local`.
  High-risk changes select full verification; `pnpm verify:local:full` forces it.
  Hosted verification and coverage are manual; main only builds and deploys.
  The pre-push hook is a scoped fast gate, not a substitute.
- Spend tool calls on bytes that earn their place. Batch independent read-only
  shell into one call, but prefer a targeted `Grep`/`Glob` over dumping a large
  file: the cost is calls x bytes returned, not calls alone. Re-read a file only
  if it changed since you read it, and read a region of a large one. Never `cd`
  — use absolute paths, `git -C`, and `pnpm --dir`, which also survives the
  per-call working directory reset.

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
  [apps/web/AGENTS.md](apps/web/AGENTS.md). For visual/design choices, also read
  [DESIGN.md](apps/web/DESIGN.md).
- **Entity genericization, the manifest/binding spine, or new-entity work:**
  [docs/entities.md](docs/entities.md).
- **iOS/macOS native app, `CubbyKit`, `cubby-ffi`, or UniFFI:**
  [apps/apple/AGENTS.md](apps/apple/AGENTS.md).

Open PRs ready for review unless the work is intentionally incomplete or the
user asks for a draft.
