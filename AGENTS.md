# Cubby agent rules

## Universal loop

- Make the requested in-scope change and choose the narrowest checks that
  verify its behavior. [Validation policy](docs/agents/validation.md) owns test
  choice and retention, failed-test read-back, subagent evidence, client
  verification, PR screenshots, and the merge gate.
- Production migrations have one exclusive owner; establish that household data
  survives before pushing, then verify the schema afterward.
- Update the doc that owns a behavior in the same change. Follow
  [documentation ownership](docs/README.md#ownership-and-pruning): one home per
  fact, executable configuration in code, completed plans/reports in Git history.
- Keep edits disjoint across agents/worktrees. Work directly by default; before
  spawning (including a Codex hand-off), load [model
  routing](docs/agents/model-routing.md) and use its lane, effort, review, and
  handoff contract. Preserve an explicit user model choice and the current main
  session.
- Use synthetic data in repository content and outward-facing engineering text.
  Never include personal or household information, real Cubby entity identifiers
  or records, or private source material in docs, comments, fixtures, examples,
  logs/screenshots, PR titles or bodies, review comments, or commit messages.
  Preserve functional public links; describe regressions using sanitized
  examples. The `commit-msg` hook and the CI `Plan` job reject a live entity
  code in a commit message or PR text (`scripts/check-outward-text.ts`); the
  documented example body `4K7M` is the one code they allow.
- Comments preserve constraints, regressions, contracts, and active TODOs—not
  narration.
- Write the failure modes and any failing isolated test before the
  implementation it guards; prefer E2E as the sole automated test when it
  covers those failures.
- Spend tool calls on bytes that earn their place. Batch independent read-only
  shell into one call, but prefer a targeted `Grep`/`Glob` over dumping a large
  file: the cost is calls x bytes returned, not calls alone. Re-read a file only
  if it changed since you read it, and read a region of a large one. Never `cd`
  — use absolute paths, `git -C`, and `pnpm --dir`, which also survives the
  per-call working directory reset.
- The done report lists what the change deleted and names every check that did
  not run.
- A correction becomes a rule in the doc that owns it. A repeated mistake means
  that rule is unclear: rewrite it in place.

## Breaking changes

One trusted household uses Cubby, and we ship and refresh every client (web,
iOS/macOS, HTTP, MCP connections), so change contracts in place:

- Change an API, RPC, MCP tool, manifest, or stored shape directly, update
  every client in the same change, and delete the old shape. A client running
  old code reloads, reconnects, or updates; a wire break for the native app
  bumps `APPLE_CLIENT_COMPATIBILITY_VERSION` in
  `packages/shared/src/apple-client-version.ts` (shared by the server minimum
  and generated Apple marketing version).
- Household data is real: carry it through a migration that transforms it.
  Ask before deleting a database or resetting data.

## Generic by default

Cubby's entities share one declaration spine, and every client — web, iOS and
macOS, HTTP/OpenAPI, MCP, and the server — should need as little hand-written
per-entity code as possible.

- **Manifest first.** Entity behavior (fields, shapes, filters, sorts, list
  columns, edit intents, validation, relations, saved views, presentation) is
  declared in `packages/schemas/src/entity-definitions/*.entity.ts` and
  generated for every client. Add a capability to the declaration and the
  generic renderer/runtime, then delete the per-entity twin; keep a remaining
  exception explicit in the declaration or a typed hook registry.
- **Same shapes everywhere.** Entities reuse field names, field kinds, display
  formats, and record shapes (ids and shortcodes, timestamps, notes, tags,
  images, provenance, money). Reach for an existing kind or format before
  inventing one.
- **Derive types; never restate them.** TypeScript types come from Zod
  (`z.infer`), generated manifests, Drizzle, or `Pick`/`Omit` of those; Swift
  types come from the generated OpenAPI and entity manifest. Cross-Worker RPCs
  share one Zod contract.
- **Generate over hand-write.** Code that is a function of declarations or
  contracts belongs in `pnpm generate` output with a drift check.
- **Reuse before writing.** Search [generic paths](docs/agents/generic-paths.md)
  and the codebase for an existing helper or generic path, and extend it rather
  than fork it.
- **Finish migrations.** A change that introduces a generic path moves every
  caller in the same change. Only a migration too large for one PR records its
  remainder in a shrink-only baseline and a `docs/todos.md` entry. Lint rules in `tools/oxlint/cubby/` and shrink-only
  boundary tests enforce the common cases.

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
  plans, `cubby-pr-ci-maintenance` for PR or CI work, `decision-grading` for
  measuring Jev/Clef decisions or Email relevance, and the focused meal,
  garden-plan, product-enrichment, or purchase-import skill for those
  household workflows.
- **Engineering diagnosis:** Use `diagnosing-bugs` for hard regressions,
  `domain-modeling` for terminology ([glossary](docs/guide/terminology.md)) or durable model decisions, `tdd` when
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
