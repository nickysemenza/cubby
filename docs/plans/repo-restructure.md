# Repository restructure (one PR)

Status: approved by the owner (grilled) and reviewed by Fable/high; all review
findings are folded in below. Ready to implement. The implementing PR deletes
this file; its PR body keeps the summary.

## Session handoff

- Start a fresh branch from the latest `main`. Line numbers and counts below
  were measured at `ad503de6a`; re-check them if `main` has moved.
  `/tmp/restructure/` is scratch, created by phase 0.
- Full scope in one PR (owner rejected the core-only cut). Go straight through
  phases 0–4 without a checkpoint after the phase-0 dry run.
- Speed setup: a script drafts `assignments.tsv` (longest entity name found in
  the filename, exact match only) and the main agent corrects the
  ambiguous/unmatched rows. Phase-0 drafting may fan out to three read-only
  Opus/medium agents (server `repo/`; `services/` + `operations/` + server top
  level; client + `tooling/` + `scripts/`); the main agent merges and checks
  collisions. Haiku/low is used only for search sweeps (stray path references,
  CI log triage). No Sonnet lanes.
- Never commit `/tmp/restructure/**`. Open the PR ready for review,
  register it with `link_pull_request`, then run the review below. After the
  squash merge, open the one-line `.git-blame-ignore-revs` follow-up PR.

## Goal

Reorganize files and folders across the monorepo in one PR so that every
entity's server code lives in one domain folder, the client mirrors the same
domain names, flat grab-bag folders disappear, and lint/tests keep the layout
from regressing. Pure moves wherever possible; no logic changes beyond what a
move forces.

## Settled decisions

| #                         | Decision                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope                     | Tier C: domain-first server, plus web client, skeleton, Apple S1–M3, docs.                                                                                      |
| Concurrency               | Owner merges nothing else until this lands (freeze).                                                                                                            |
| Commits                   | One PR, squash-merged; a one-line follow-up PR adds the squash SHA to `.git-blame-ignore-revs`.                                                                 |
| Naming                    | kebab-case for TS/TSX files and all folders, lint-enforced. Swift PascalCase, Rust snake_case untouched.                                                        |
| Domain grain              | One folder per entity (29) under `apps/web/src/server/domains/<entity>/`; cross-entity workflow features are sibling folders in `domains/`.                     |
| Cross-entity capabilities | `apps/web/src/server/generic/<capability>/`.                                                                                                                    |
| Inside a domain           | Fixed role names: `repo.ts`, `service.ts`, `operations.server.ts`; a role becomes a same-named folder when large (`repo/crud.ts`). Tests sit beside their file. |
| Layer direction           | New cubby oxlint rule + shrink-only baseline for existing violations; burn-down todo.                                                                           |
| Client                    | `app/` + `features/` merge into `src/features/<name>/` using the server's domain names (singular kebab); client and server trees stay separate.                 |
| File splits               | None. Oversized files (>1500 lines) get a todo.                                                                                                                 |
| Layout guard              | Shrink-only `layout.unit.test.ts`.                                                                                                                              |
| Barrels                   | No new `index.ts` re-exports in `domains/*`, `generic/*`, `features/*`; existing platform barrels stay; burn-down todo.                                         |
| Aliases                   | `~/` stays the only alias.                                                                                                                                      |
| `.server.ts`              | Existing names keep their suffix (nothing keys on it); roles are defined by path segment.                                                                       |
| Apple                     | S1–M3 only; D1–D3 become todos.                                                                                                                                 |
| Docs                      | Cleanup + fold orphans + app-specific agent docs move to `apps/*/docs/`; no domain/engineering split. ADR 0017 records the layout.                              |

## Target layout

### `apps/web/src/server/`

```
server/
  worker-bindings.ts  cf-env.ts            # allowlisted top-level files
  # Placements fixed by review: image-processing/ (DO + socket route) →
  # domains/image-processing/; database-freshness/ (DO) → db/freshness/;
  # runs/ → domains/run/; utils/ → clients/; telemetry-queue* → observability/;
  # maintenance.ts, workload.ts → http/; ai-refresh-startup.ts,
  # search-index-repair-workflow-adapter.ts → workflows/;
  # purchase-agent-queue-types.ts → domains/purchase-agent/.
  # cf-server.ts DO re-exports and wrangler.jsonc bindings follow.
  domains/<entity>/                        # 29 entities, kebab of manifest name
  domains/<feature>/                       # cross-entity workflows
  generic/<capability>/                    # entity-agnostic capabilities
  db.ts          # stays (504 `~/server/db` imports; avoids an index barrel)
  db/            # + db-pg-client, db-pg-tracing, db-runtime-resolver,
                 #   db-observability, read-consistency, read-policy
  entity-kernel/ mcp/ ai/ generated/ errors/ clients/ (+ utils/*)
  operation-runtime/  # start-operation*, operation-domain, subscription-domain,
                      # workflow-stream*, browser-operation-dispatch, entity-runtime,
                      # entity-list-runtime, middleware/*
  workflows/          # workflow-runtime/, workflow-runs/, background-tasks/,
                      # *-workflow.ts, background-queue-types, settle-batch,
                      # statement-csv-import, gmail-workflows
  http/               # request-context, request-services, http-*, apple-client-gate,
                      # native-workspace-session, apple-app-site-association,
                      # direct-socket-paths, deferred-service, oauth/
  observability/      # telemetry*, tracing, observed-request, worker-sentry
  testing/            # + repo/repo.fixtures, mcp/mcp-test-utils,
                      #   repo/database-helpers/mock-db, test-duration-override
```

`repo/database-helpers/` moves to `db/helpers/` only if its 524 imports rewrite
cleanly; otherwise it stays at `server/repo/database-helpers/` as the last
resident of `repo/` (decide in phase 0 by codemod dry run; prefer moving).

**Entities** (`domains/`): product, recipe, ingredient, cookbook, location,
inventory, meal, ledger-party, ledger-transfer, project, task, vendor, purchase,
financial-account, financial-transaction, wish, expense, usda-food, image,
planting, garden-entry, vendor-account, product-category, run, device, plant,
spending-category, email, image-job. Child rows live with their parent
(MealRecipe → meal, sections → recipe, unit mappings → product, growing guides
`garden-guides/` → plant).

**Feature domains** (`domains/`): purchase-import (+ `agents/purchase-import/`),
purchase-agent (security boundary; lint rule
`tools/oxlint/cubby/rules/purchase-agent-boundary.ts` and `.oxlintrc.json:230`
retarget to the new path), photo-import (`photo-import-run/`,
`services/photo-import-*`, `photo-import.server.ts`), calendar, usda-release,
statement-import (statement-row*, statement-import-membership),
household-contribution, mail (Gmail ingest / retained-mail / attachments, apart
from the Email entity's own repo).

**Generic capabilities** (`generic/`): merge, removal, relatedness,
data-quality, problems (repo/problems + services/problem* + operations/problem*),
entity-report, entity-graph, embedding (semantic/, entity-embedding*,
embedding-readiness, semantic-search), search (search-_, lexical), collection,
work-queue, field-explanation, suggestions (suggestion-_, field-resolution-_),
audit-log, activity, inheritance, entity-links (entity-links, entity-external-ids,
entity-media, entity-edge-source, connected-records, related-view),
entity-timeline, shortcode, list (list-_, filter-options, label-_), integrity
(entity-integrity_, image-integrity stays in image).

Mapping is exact, never by name prefix. A domain folder's name is exactly the
entity's kebab-case manifest name. Only these shapes map automatically:

- `repo/<entity>/**`, `repo/<entity>.ts`, `repo/<entity>.repository.ts`
  → `domains/<entity>/repo/…` (a lone file → `repo.ts`);
- `services/<entity>.service.ts` → `domains/<entity>/service.ts`;
- `operations/<entity>.server.ts` → `domains/<entity>/operations.server.ts`.

Every other file in a reorganized folder is assigned by an explicit one-line
entry (`old path → new path`) in `assignments.tsv`; there are no wildcards, so
`product-category.ts` can never fall into `product/`. Phase 0 fails while any
file in a reorganized folder lacks an entry. Assignments keep the file's base
name inside the role folder (`repo/image-sighting.ts` →
`domains/image/repo/image-sighting.ts`); if a role holds more than one file it
becomes a folder. Multi-entity files (`finance.server`, `related-data.server`,
`recommendations.server`, `dashboard`) go to one named owner and are never
split. `repo/garden/` becomes a `domains/garden/` feature folder shared by
planting and garden-entry, with its `index.ts` barrel dissolved into direct
imports. The main agent writes `assignments.tsv` from the file inventory. It and the
codemod scripts live in `/tmp/restructure/` and are never committed; the PR
reviewer reads them there, and the PR body carries a per-folder summary.

### `apps/web/src/` (client)

- `app/<x>` + `features/<x>` → `features/<domain>/` with route bodies in
  `pages/` and `slots.tsx`/`list-slots.tsx` at the folder root. Names are the
  server domain names (`products`→`product`, `finance`→ the owning
  financial-* domain or a `finance` feature folder for cross-entity screens).
- Non-domain features keep feature folders: ai, command-menu, developer, home,
  search, units, labels, nutrition, performance, schedule, audit-log, account,
  auth, design, docs, legal, tools, calendar; `queue-pass` folds into
  `work-queue`; `features/entity-platform` folds into `entity/`.
- `ui/`: `layouts`→`layout`, `navbar`+`MainNav`→`navigation`, form helpers →
  `forms/`, `table/`→`data-table/`, `page/`→`layout/`, route states →
  `feedback/`, text renderers → `text/`.
- `ui/hooks/` data hooks → `entity/hooks/` (entity/query) or
  `integrations/tanstack-query/hooks/`; DOM hooks stay.
- `entity/` subfolders: `problems/`, `model/` (isomorphic: list-read-*,
  view-manifest), `display/`, `fields/`. `entities.tsx`, `filter-behavior.ts`,
  `filter-manifest.ts`, `list-columns/`, `generated/` stay.
- `lib/`: server-only modules → `server/` (owning domain or `server/lib/`);
  single-consumer modules move next to the consumer; `status-colors` merges into
  `status-tone`; `utils.ts` re-exports of number-format/round-to drop.
- `tests/e2e/`: helpers → `support/`, `fixtures-*.ts` → `fixtures/`.
- Kebab-case rename of ~215 PascalCase/camelCase files (two-step `git mv`).

Generated outputs move with their owning folder: edit the generator's output
constants (`render/index.ts:1672` shortcode tables, `render/coverage-totals.ts:53`,
`agent-prompts.ts:29`, …); `*.gen.ts` are gitignored, so phase 3 starts with
`git clean -fX apps/web/src` and `pnpm generate`.

Must not move: `routes/` and `routeTree.gen.ts`; generated folders that are not
inside a reorganized folder (`entity/generated`, `lib/generated`,
`integrations/tanstack-query/generated`, `server/generated`, `db/generated`);
`lib/auth-guard.ts` and `lib/build-metadata.ts` (server-function IDs, e2e URL
match);
`contracts/{index,define,mcp-define,mcp-tools}.ts`; `lib/http-api/{wire,router}`;
`lib/recipebridge-cf.ts`, `lib/sentry-cf-shim.ts`; `lib/household-date.ts`,
`lib/plain-date.ts`; `ui/feedback/error-details.tsx`;
`integrations/tanstack-query/operation-overrides.ts`; `ui/primitives`,
`ui/reui`; `lib/test/`. The one other `createServerFn` file
(`features/ai/server-functions/ai-smoke.ts`) stays at its path.

### Skeleton

- `scripts/generator/` → `apps/web/generator/` (fix `"../../.."` root depths,
  tsconfig include, root `project.json` generate command/inputs, knip, docs).
- `apps/web/tooling/` → `test/`, `db/`, `e2e/`, `native/`, `workerd/`,
  `local-providers/`, `checks/` (absorbs `apps/web/scripts/*`); `test-setup.ts`,
  `factories/`, `scenarios/`, fixtures stay at the root; tester-army halves join.
  Root `scripts/native-*.test.ts` move into `tooling/native/`.
- `scripts/apple/` gets apple-_, mac-_, simulator-*, shared-device-command and
  their lib helpers; `ensure.ts`, `test-services.ts`, `dev-db.ts`, `ci-lanes.ts`,
  `check-outward-text.ts` stay at `scripts/`. `test:scripts` glob →
  `scripts/**/*.test.ts`.
- `scripts/anti-slop-rules.test.ts` + `scripts/fixtures/anti-slop/` →
  `tools/oxlint/`. Update its `repoRoot` constant (plants fixtures under
  `apps/web/src/server/.lint-fixture-*`) and make `test:scripts` also run
  `tools/oxlint/**/*.test.ts`.
- `.gitignore` drops stale prisma/Next entries.
- Untouched (cut after review for cost): Rust crates stay at the root (todo:
  `crates/`), `packages/shared/src` keeps its layout, `apps/web-worker-tests`
  stays. Also untouched: `@cubby/schemas` name, `packages/wasm`,
  `scripts/ensure.ts`, `golden-vectors/`, `drizzle/`, `apps/nx-cache`, root
  tool configs.

### Apple (S1–M3)

`App/Shared` loose files → `AppShell/`, `Auth/`; `Settings/` absorbs
`SettingsView` + `Notifications`; `Browse/` → `Entity/{Detail,List,Relationships}`,
`Finance/`, `Graph/`, `Run/`, `Recipe/`, `Report/`; `Photo/Library` →
`Library/`, `Import/`, `Review/`; `UI`+`Theme`+`Presentation` → `DesignSystem/`
(update `FieldGuideMetrics.swift` path in `scripts/design-tokens.ts:159`,
`.github/ci-lanes.yml`, root `project.json:69`); `App/Tests` mirror sources
(`Photos`→`Photo`); Live Activity shared attributes → `App/LiveActivity/Shared/`;
CubbyKit `Catalog` split and `FinancialBooking*` → `Finance/`; CubbyKit tests
mirror sources; preview fixtures → `apps/apple/Generated/PreviewFixtures/`.
Do not touch `CubbyAPI`, `CubbyAPISupport`, `CubbyFFI`, `Frameworks/`,
`project.yml` structure beyond paths, `GoldenVectors.swift` depth,
`Support/Gate.swift`, `e2e/`.

### Docs

- Renumber `adr/0015-current-member-filter-token.md` → `0016-…` (6 refs).
- Repoint the 11 references to deleted `docs/reports/local-check-performance.md`.
- Delete `docs/research/` (drizzle spike → ADR or todos; gateway → `infrastructure.md`),
  `plans/photo-identification.md` (durable parts → behavior doc),
  `plans/entity-defaults.md` (remainder → todos).
- Fold `list-read-pipeline`, `relationship-discovery`, `product-relationship-route`
  into `entities.md`; `application-framework/README.md` into `entities.md`.
- `docs/agents/xcode-mcp.md` → `apps/apple/docs/`; `web-ui.md`,
  `web-runtime.md`, `web-ui-reference.md` → `apps/web/docs/`. Add the
  `docs/README.md` ownership row for `apps/*/docs/` and update AGENTS.md
  "Load when triggered" links.
- Add `docs/adr/README.md` index; normalize ADR headings.
- Narrow `apps/web/project.json` `build-cf` docs input to `docs/guide/**/*.md`.
- New ADR 0017 "Domain-first server layout"; rewrite
  `docs/agents/domain-rules.md` repo/service section and
  `docs/agents/generic-paths.md` paths; `docs/development.md` architecture.
- Fix `.claude/workflows/repo-audit.js` lane paths (already stale).
- `docs/todos.md` entries: layer-violation baseline burn-down; barrel burn-down;
  oversized-file splits (list); Apple D1–D3; `lib/` isomorphic-only and
  client `ui→features`/`entity→app` inversions (boundary baseline);
  `apps/web-worker-tests` shim removal when the plugin supports Vitest 5;
  generated output consolidation in `server/` (four locations);
  Rust crates under `crates/`.

## Enforcement added

1. `tools/oxlint/cubby/rules/domain-layers.ts`, roles by path segment
   (`domains/<x>/<role>[.*|/]`), not suffix: `operations` → `service` → `repo`
   → `db`; `repo` may not import
   `ai/` or any `service`; cross-domain imports allowed to same-or-lower role;
   `generic/*` and platform folders may not import `domains/*/{service,operations}`.
   Replaces `.oxlintrc.json:126`. Baseline JSON, shrink-only.
2. Client boundary rule (same rule file or sibling): `ui` ↛ `features|entity`,
   `entity` ↛ `features` pages; baseline, shrink-only.
3. No-barrel rule for `domains/*`, `generic/*`, `features/*`.
4. `apps/web/tooling/layout.unit.test.ts` (a test, not a lint rule): kebab-case,
   domain-folder role allowlist, server top-level allowlist, ≤40 direct source
   files per folder (existing offenders baselined).

## Execution

Main agent owns phases 0–4 and final integration. One Opus/medium lane owns
Apple S1–M3 and docs moves; it starts only after phase 2 is committed on the
branch (the codemod's text pass touches `apps/apple/**` and `docs/**`), and runs
the same rewrite script against its own manifest. Freeze is assumed; still re-run phase 1–3 on fresh
`main` before merge if anything landed.

0. **Manifest.** `/tmp/restructure/build-manifest.ts` combines the exact
   entity-name shapes, whole-folder moves (e.g. `workflow-runs/` →
   `workflows/runs/`), and `assignments.tsv` into `manifest.json` (old→new).
   It fails on any unassigned file under a reorganized folder, any collision,
   or a move of a must-not-move file; it reports case-only renames.
1. **Move.** `git mv` per manifest (two-step for case-only).
2. **Rewrite.** One Node script over all tracked text files:
   - `~/` is pinned globally to `apps/web/src` (the generator's template
     strings live outside `apps/web`);
   - every relative specifier is recomputed from the importer's new location
     even when the target did not move; specifiers resolve with or without
     extension, `?raw`/`?url` suffixes, and `<dir>` for `<dir>/index.ts`
     (emitted back as `<dir>`); covers static/dynamic imports, entity
     `module:` strings, generator template strings;
   - `import.meta.glob` patterns resolve their static directory prefix and are
     rewritten; paired prefix constants are hand-listed in phase 3
     (`app/docs/docs-registry.tsx` `DOCS_PREFIX`,
     `purchase-agent/import-run-workflows.ts`,
     `purchase-import/gmail/email-html.fixtures.ts`,
     `entity/generated-filter-fields.unit.test.ts`) with a unit assertion that
     each eager glob is non-empty;
   - repo-relative AND app-relative (`src/server/...` in `apps/web` configs)
     path text, directory prefixes and globs in md/json/jsonc/yaml/toml/sh/
     swift/rs/ts comments and configs rewritten from the manifest's directory
     map;
   - prints anything that looks like a moved path but did not resolve; after
     the run, grep the generator for `~/` strings missing on disk.
     Scratch scripts live outside the repo and are not committed.
3. **Fix-ups (hand).** Root-depth constants (`resolve(dirname, "..")` in moved
   scripts/generator; GoldenVectors untouched), workspace globs, nx/knip/vitest
   globs, `project.yml` explicit paths, wrangler entries, oxlint overrides and
   baselines (rewrite keys, never drop), `ci-lanes.yml` via `pnpm generate`.
4. **Enforcement + docs.** Rules, layout test, ADR, docs, todos.

## Validation

Narrow and fast first, filtered to error lines:

1. `pnpm generate` — clean, no drift.
2. `pnpm typecheck` (TS 7 native).
3. `pnpm lint` (oxlint incl. new rules), `pnpm knip`.
4. `pnpm test:scripts`; web unit + preview projects; `cargo check` workspace;
   `pnpm --filter @cubby/web build-cf` (bundle closure checks).
5. Integration (`pnpm test:postgres` lane), workers tests, e2e, Apple
   `scripts/apple.ts` build+tests — via CI on the PR; local only for failures.
6. Path-existence assertion: every path-looking string in `vitest.config.ts`,
   `playwright.config.ts`, `knip.json`, `.oxlintrc.json`, `nx.json`,
   `project.json`s, `.github/**`, and `*-baseline.json` exists on disk.
7. CI lanes: after `pnpm generate` refreshes `.github/ci-lanes.yml`, confirm the
   PR's `plan` job selects every lane; otherwise trigger the manual full run
   before merge.
8. Grep gates: no remaining `src/server/repo/`, `src/server/services/`,
   `src/server/operations/`, `src/app/`, or `scripts/generator` path text
   outside the blame/ADR history. (The Rust crates stay at the root, so
   `recipebridge/` and `cubby-ffi/` are not gated.)

## Review

- Fable/high reviewed this plan (done).
- PR: `gpt-6.1-sol`/high review plus a Fable/high second review (major
  infra/CI/lint change needs both providers), each given `/tmp/restructure/`
  (manifest, assignments) and the non-rename diff (`git diff -M` excluding pure
  renames and specifier-only hunks).

## Risks

- Server function IDs derive from source path: moved `createServerFn` files
  change RPC URLs; open tabs reload. Listed in PR.
- Nx/CI caches keyed by paths cold-miss once.
- Durable Object class/module names in `wrangler.jsonc` must keep resolving;
  workers-test globs (`tools/web-worker-tests/vitest.config.ts`) updated.
- Case-insensitive macOS FS: two-step renames; verify with `git ls-files`.
- Golden-vector relative paths from Rust/Swift.
- Every lint rule message and baseline keyed by path.
