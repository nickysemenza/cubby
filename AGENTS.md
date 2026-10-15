# Cubby agent rules

## Universal loop

- Make the requested in-scope change and choose the narrowest checks that
  verify its behavior. [Validation policy](docs/agents/validation.md) owns test
  choice and retention, failed-test read-back, subagent evidence, client
  verification, PR screenshots, and the merge gate.
- Update the doc that owns a behavior in the same change. Follow
  [documentation ownership](docs/README.md#ownership-and-pruning): one home per
  fact, executable configuration in code, completed plans/reports in Git history.
- Keep edits disjoint across agents/worktrees. Work directly by default; before
  spawning (including a Codex hand-off), load [model
  routing](docs/agents/model-routing.md) and use its lane, effort, review, and
  handoff contract. Preserve an explicit user model choice and the current main
  session.
- Use synthetic data in all repository and outward-facing content, including
  diagnostics and screenshots; exclude private source material and real entity
  identifiers. Preserve functional public links.
- Comments preserve constraints, regressions, contracts, and active TODOs—not
  narration.
- Write the failure modes and any failing isolated test before the
  implementation it guards; prefer E2E as the sole automated test when it
  covers those failures.
- Bound tool output before returning it: targeted `rg`, file regions, selected
  JSON fields, and failure excerpts. Save verbose logs under ignored
  `artifacts/` and retrieve relevant regions; a truncated dump is not evidence.
  Batch independent reads within one shared output budget. Reuse unchanged
  reads. Use absolute paths, `git -C`, and `pnpm --dir`; never `cd`.
- The done report lists what the change deleted.
- A correction becomes a rule in the doc that owns it. A repeated mistake means
  that rule is unclear: rewrite it in place.

## Breaking changes

Ask before deleting a database or resetting data.

Change contracts in place and carry stored data through migrations. For API,
RPC, MCP, manifest, stored-shape, or native wire changes, load
[breaking changes](docs/agents/domain-rules.md#breaking-changes).

## Generic by default

Reuse before writing: search [generic paths](docs/agents/generic-paths.md).
Entity behavior belongs in declarations and generic runtimes; for entity or
cross-client changes, load [declaration rules](docs/entities.md#generic-by-default).

## Product constraints

The [README tenets](README.md#tenets) are binding: inventory never
auto-decrements; `fdc_id` is product-only; rare interactive work stays
interactive; all money is `SUM(Expense.cost)`; the trusted household has no
multi-user coordination, restore/undo, reservations, or locking. Because the
trusted household is the only audience, error surfaces (toasts, Technical
details, HTTP/MCP error bodies) show raw diagnostics — SQL text and
parameters, Postgres SQLSTATE codes, upstream response bodies — and are never
masked or softened into generic messages; the only redaction is
credential-shaped values (`scrubErrorMessage`). The README holds the entity map
and example household scenarios; [development](docs/development.md) holds
architecture, commands, testing, and deployment. Read only the relevant heading.

## Skill routing

Use one owning skill; add another only for a distinct concern.

- Unresolved material design decisions: `grilling`; approved briefs proceed.
- Web UI: `impeccable` and `apps/web/DESIGN.md`; broad sweeps:
  `cubby-ui-design-audit`. Refinement: `better-ui` or `emil-design-eng`.
- Apple UI: `axiom-design` then `axiom-swiftui`; add the relevant platform skill.
- Plans: `cubby-adversarial-plan-review`. PR fixes/CI:
  `cubby-pr-ci-maintenance`. Decision evaluation: `decision-grading`.
- Household operations: the matching meal, maintenance, garden, photo,
  enrichment, or purchase skill.
- Hard regressions: `diagnosing-bugs`. Terminology/model decisions:
  `domain-modeling`. Requested test-first work: `tdd`; review: `code-review`.
  Shared terms: [Terminology](docs/guide/terminology.md); household labels and
  storage roles: [GLOSSARY.md](GLOSSARY.md).

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

For dev startup, readiness, login, or Cursor Cloud, load
[local development](docs/local-development.md#start-and-discover).
