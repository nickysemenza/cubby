# Cubby agent rules

## Universal loop

- Make the requested in-scope change; validate at the narrowest tier that can
  fail. `pnpm typecheck` is cheap. Run one file with `pnpm test:file src/…`
  (path relative to `apps/web`) — that is the spelling, not `vitest`/`npx
  vitest`. At handoff, the root agent runs `pnpm check` plus affected tests;
  GitHub Actions is the required full verification before merge.
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
- Git hooks are mandatory validation. Pre-commit runs `pnpm check`; pre-push
  runs the affected static and fast-test graph. Never use `--no-verify` to
  bypass either.
- `pnpm verify:local(:full)` remains the explicit local full-diagnostic path.
  Before merge, GitHub Actions must pass on the exact final PR head. Coverage
  remains manually dispatchable; `main` runs CI after deployment starts.
- Spend tool calls on bytes that earn their place. Batch independent read-only
  shell into one call, but prefer a targeted `Grep`/`Glob` over dumping a large
  file: the cost is calls x bytes returned, not calls alone. Re-read a file only
  if it changed since you read it, and read a region of a large one. Never `cd`
  — use absolute paths, `git -C`, and `pnpm --dir`, which also survives the
  per-call working directory reset.
- **Model, delegation, and context routing:** use the cheapest model that can
  independently validate the task; load [model routing](docs/agents/model-routing.md)
  when choosing a model, effort level, subagent, or context boundary.

## Product constraints

The [README tenets](README.md#tenets) are binding: inventory never
auto-decrements; `fdc_id` is product-only; rare interactive work stays
interactive; all money is `SUM(Expense.cost)`; the trusted household has no
multi-user coordination, restore/undo, reservations, or locking. Read only the
relevant README heading for architecture, commands, entities, deployment, or
roadmap context.

## Skill routing

Use one owning skill for a matching workflow; add a narrower skill only when it
owns a distinct concern.

- **Uncertain plans or designs:** When the user explicitly says “grill me,” or
  material product or design decisions remain after repository investigation,
  use `grilling` to resolve them before implementation. An approved
  implementation brief proceeds directly to implementation.
- **Web UI:** For a UI change, redesign, or visual polish, use `impeccable`
  with `apps/web/DESIGN.md`. For a broad cross-route audit or responsive
  remediation, use `cubby-ui-design-audit`. Use `better-ui` or
  `emil-design-eng` as focused refinement lenses.
- **Apple UI:** For iOS/macOS visual or interaction work, use `axiom-design`
  before implementation decisions and `axiom-swiftui` for SwiftUI. Add the
  relevant Axiom skill for accessibility, performance, UIKit, media, data,
  networking, security, or platform-specific work.
- **Cubby workflows:** Use `cubby-adversarial-plan-review` for implementation
  plans, `cubby-pr-ci-maintenance` for PR or CI work, and the focused meal,
  garden-plan, product-enrichment, or purchase-import skill for those
  household workflows.
- **Engineering diagnosis:** Use `diagnosing-bugs` for hard regressions,
  `domain-modeling` for terminology or durable model decisions, `tdd` when
  test-first is requested, and `code-review` for a requested review.

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
