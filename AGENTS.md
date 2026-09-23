# Cubby agent rules

## Universal loop

- Make the requested in-scope change and choose the narrowest checks that
  verify its behavior. Follow [validation policy](docs/agents/validation.md)
  for local feedback, cheap Git operations, and the required GitHub merge gate.
- A failing test run already lists what failed, at the end of its output and in
  `apps/web/.vitest-failures.txt`. Read those instead of re-running the tier —
  measured, 24% of all test runs were a re-run of one that had just failed.
- A subagent runs only focused tests and returns distilled evidence (result, command,
  duration, relevant output, and limits). The root owns any needed broad
  validation; others continue useful work while it runs. Reuse unchanged
  results at handoff instead of rerunning checks for publication.
- Production migrations have one exclusive owner; establish safe data and
  deployed-code compatibility before pushing, then verify the schema afterward.
- Keep edits disjoint across agents/worktrees. Claude main sessions default to
  `opus` at medium effort (`.claude/settings.json`); Codex pins no model. A
  session's explicit `/model` or effort choice wins. Work directly by default:
  finish in the main session anything a handful of tool calls covers, including
  lookups in a known file. Delegate only independent tracks that run in
  parallel, a broad read-heavy sweep, or an approved multi-unit implementation;
  use an independent review agent only for broad or risky work.
- Use synthetic data in repository content and outward-facing engineering text.
  Never include personal or household information, real Cubby entity identifiers
  or records, or private source material in docs, comments, fixtures, examples,
  logs/screenshots, PR titles or bodies, review comments, or commit messages.
  Preserve functional public links; describe regressions using sanitized
  examples. The `commit-msg` hook and the CI `Scope` job reject a live entity
  code in a commit message or PR text (`scripts/check-outward-text.ts`); the
  documented example body `4K7M` is the one code they allow.
- Comments preserve constraints, regressions, contracts, and active TODOs—not
  narration.
- A test earns its place by failing on a behavior regression the type system
  cannot catch. Delete tests that only prove existence, exercise a mock, or
  restate a typecheck; consolidate same-shape per-entity tests into one
  table-driven test. A test that names a regression or invariant in a comment
  is consolidated, never dropped.
- Spend tool calls on bytes that earn their place. Batch independent read-only
  shell into one call, but prefer a targeted `Grep`/`Glob` over dumping a large
  file: the cost is calls x bytes returned, not calls alone. Re-read a file only
  if it changed since you read it, and read a region of a large one. Never `cd`
  — use absolute paths, `git -C`, and `pnpm --dir`, which also survives the
  per-call working directory reset.
- **Model, delegation, and context routing:** before spawning (including a
  Codex hand-off), load [model
  routing](docs/agents/model-routing.md), select an explicit supported
  model/effort pair, and use its compact handoff contract. Preserve an explicit
  user model choice and the current main session.

## Product constraints

The [README tenets](README.md#tenets) are binding: inventory never
auto-decrements; `fdc_id` is product-only; rare interactive work stays
interactive; all money is `SUM(Expense.cost)`; the trusted household has no
multi-user coordination, restore/undo, reservations, or locking. Because the
trusted household is the only audience, error surfaces (toasts, Technical
details, HTTP/MCP error bodies) show raw diagnostics — SQL text and
parameters, Postgres SQLSTATE codes, upstream response bodies — and are never
masked or softened into generic messages; the only redaction is
credential-shaped values (`scrubErrorMessage`). Read only the relevant README
heading for architecture, commands, entities, deployment, or roadmap context.

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
