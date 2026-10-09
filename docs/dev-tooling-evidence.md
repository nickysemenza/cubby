# Developer tooling and test signal evidence

The feedback loop uses deterministic service read-back for stored correctness,
small user journeys for navigation and edits, and previews for presentation.
The isolated suite keeps distinct failures that those boundaries cannot expose.
This change removes 85 source-level cases across the two test-audit passes and
Tester Army consolidation; parameterized runtime case counts differ. Nineteen
whole files are deleted and the recipe-import projections retain their named
regressions under a clearer filename. Extended native scenarios remain available
by name or `test:e2e:local --all`; the default local smoke is headless + simulator.

## Runtime recovery and iteration

Eight abandoned disposable test containers had dead owner PIDs. Recovery
verifies the expected image and absence of mounts, then stops/removes only those
per-run containers. Active runs, warm services and the persistent development
volume survive. A subprocess regression went red before `--prune` existed and
passes with the recovery command. The verified abandoned pairs were removed;
three intentional persistent services remained.

Docker development uses the same image, volume and loopback-port identity guard
as Apple container. A subprocess regression first failed on the old Apple-only
guard, then passed for owned-volume preservation and foreign-container refusal.
Apple service reuse passed on the real local service. Docker's CLI is installed
on the acceptance host but its daemon is unavailable; real Docker startup is a
separate unrun check.

The simulator app graph now has its own tracked lockfile. Real iOS and Mac
package resolution left both owned lockfiles unchanged; app-only pin additions
went to the app lockfile. A simulator-cache regression first accepted a stale
bundle after an app-only pin changed, then rejected it after including the new
lockfile. Local runs share the hosted certified-build profile.

Mac launch rejects ad-hoc/foreign-team signing under the real bundle ID. The
presentation AX helper now has a stable path and Developer ID requirement.
Actual compilation/signature verification followed by a second preparation
reported reuse of the same path and signed bytes. Existing OS consent is not
changed by these checks; a graphical permission-persistence pass remains needed.

## Live local flow checks

The development smoke passed all 17 scenarios, including real login/browser
creation, HMR updates, background queue/workflow work, persistence after restart,
independent instances and confined reset/cleanup. Its sanitized bundle is under
`artifacts/local-dev-smoke/`. This dirty-source local run is iteration evidence.

Warm HMR validation passed all three scenarios in 34.2 seconds: two generic list
presentation journeys and an owned database fixture visible in the real list,
then removed by cleanup. Switching preview states through its controls avoids
reloading the module graph four times; the previous product case exhausted its
30-second budget. The HMR bundle records source stability and replay under
`apps/web/playwright-report/hmr/`. CI still owns exact-head built acceptance.

Sol and Astra independently reviewed the change. Both confirmed the shared
simulator target is selected/validated before mutation, and failed HMR fixture
deletions retain ownership tracking while all deletions are attempted.

The simulator bundle was built and later reused with `appBuild:
reused-certified`; the warm native-build phase took 2.2 seconds. The legacy
full UI journey failed on the visible edit field: the driver reported it covered.
This establishes an interaction failure, not a completed UI edit or a conclusively
external defect. Its sanitized failure bundle is retained under `artifacts/sim-e2e/`.
Default smoke now checks search/detail identity; the headless lane checks native
client writes. The full UI edit/view/filter journey remains under
`--extended-journey` and is required for changes to those interactions.

## Natural CI sample

A [green PR run](https://github.com/nickysemenza/cubby/actions/runs/37884151913)
spent 1m49s in Auxiliary tests/builds, 5m12s in PostgreSQL tests and 7m12s/6m44s
in the two desktop E2E shards. These are whole-job times including setup, not
scenario-only benchmarks. One sample does not establish repeatable imbalance;
retain natural sharding and avoid a duration database or custom sequencer.
The exact final PR head still requires passing GitHub checks.

## Routing measurement

The UTC window 2026-09-08 through 2026-10-07 included 289 parent sessions with
assistant usage metadata; 129 (44.6%) contained a delegation tool call.
142,733 unique assistant message IDs appeared in 270,586 assistant rows.
Deduplicating message snapshots by parent session/message ID and taking the
maximum recorded usage fields gives subagents 56.2% of summed input,
cache-creation, cache-read and output tokens. Of 49,014,224 subagent output tokens,
14,264,238 (29.1%) were Opus/Fable; older Sonnet runs dominate the remainder.
Only timestamps, tool names, model names and usage metadata were aggregated;
no prompt/response text, tool inputs, transcript paths or identities are retained.

This mostly predates the routing change and its initial baseline did not retain
an identical extractor/accounting definition. It does not establish a causal
reduction, speed improvement or unchanged quality. Keep the current rule and
repeat after a full post-change window, with the same accounting and explicit
latency/quality evidence. The 47% baseline remains historical, not a claim about
the current window.

## Evidence-dependent decisions

Runtime-error suppression is unchanged. Missing update-result, opaque database,
pathological LIKE/GLOB and cancellation reports still require actual sanitized
event name/message/stack/route evidence before any broader suppression. No
production event source is available in this checkout/session; synthetic matcher
checks cannot establish those production shapes.

## Test deletion ledger

Scope: test cleanup under `apps/web/src` and `packages/*`. Regression tests added elsewhere in this change cover runtime recovery, replay, signed helper reuse and native cache invalidation.

## Deletions

- Deleted `apps/web/src/entity/editing/architecture.unit.test.ts` (2 tests). Both tests scanned source text for forbidden imports/calls and module placement. This was brittle architecture policing rather than an observable runtime contract. Related runtime coverage remains in `entity/editing/definitions.unit.test.ts`, `kernel.unit.test.ts`, and the `entity-edit-dialog.*.unit.test.tsx` cases. There is no retained check that enforces the exact source-boundary rules; those checks are intentionally removed as requested.
- Deleted `apps/web/src/server/services/problem-read-architecture.unit.test.ts` (2 tests). It scanned source strings for pagination tokens and a named constant/cast spelling. Runtime problem-domain tests remain in `entity/problem-query.unit.test.ts`, `entity/problem-registry.unit.test.ts`, `app/problems/problem-lane-state.unit.test.ts`, and `server/operations/problems.workflow.unit.test.ts`. No retained test enforces the exact pagination-token/source-shape rules; the removed source-text guard did not establish runtime behavior.
- Removed 1 assertion-only test from `apps/web/src/features/home/problems-banner.unit.test.tsx`. It pinned only the exact sentence `No defects found.` The retained component test covers visible banner content, coverage count, and destination link; product copy remains rendered by the same component/helper without a standalone exact-copy pin.

## Initial audit totals

- Deleted files: 2.
- Deleted test cases: 5 (4 in deleted files, 1 standalone exact-copy case).
- Modified retained test files: 1.
- Protected runtime behavior removed: none intentionally. The two deleted architecture tests had no runtime assertion; their source-boundary constraints no longer have dedicated automated enforcement.

---

## Comprehensive audit

Method: inventoried all 799 tracked `*.unit.test.ts(x)` / `packages/*/src/*.test.ts` files (lines, case count, `vi.mock`/`vi.fn`/`toHaveBeenCalled` density, source-scan APIs, manifest-roster references); read every file under 45 lines in full, and every remaining file's describe/it titles (5,861 title lines) with targeted body reads for suspect titles. No `vi.mock` exists in the corpus, so "mocked UI" was audited via callback-only assertions. Not edited: production code, config, scripts, tooling (incl. Tester Army), Apple, docs. No tests added.

Legend: **NBC** = no behavioral contract (declaration/constant/copy/source-shape pin, or tests a test helper); **RC** = replacement coverage named.

## Whole files deleted (17 files, 31 source cases)

| File                                                                                | Cases              | Kind              | Proof                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/app/purchases/purchase-import-links.unit.test.ts`                     | 1                  | NBC               | Pinned `runHref("RUN-4K7M") === "/runs/RUN-4K7M"`, a string template; route typing (`EntityDetailRoute`, kept type test in `entities.unit.test.ts`) guards route shape.                                                                                                                         |
| `apps/web/src/server/operations/task.workflow.unit.test.ts`                         | 1                  | NBC + RC          | Pinned declared step-type list of one workflow. Commit/effect ordering semantics are enforced at runtime by `workflow-runtime/builder.unit.test.ts` ("rejects effects without an immediately preceding commit or effect", "does not run effects when cancellation or failure prevents commit"). |
| `apps/web/src/server/operations/product.workflow.unit.test.ts`                      | 1                  | NBC + RC          | Pinned name/concurrency(10)/cadence constants and step names. Same runtime RC as above; bulk semantics in `workflow-runtime/bulk.unit.test.ts`.                                                                                                                                                 |
| `apps/web/src/server/operations/purchase.workflow.unit.test.ts`                     | 1                  | NBC + RC          | Step name/type pins for two definitions. RC: builder.unit (effect-after-commit rule).                                                                                                                                                                                                           |
| `apps/web/src/server/operations/search.workflow.unit.test.ts`                       | 1                  | NBC + RC          | Step-graph pin. RC: builder.unit branch tests ("passes prior outputs into typed parallel branches and skips the unselected branch"); readiness behavior in `embedding-readiness.service.unit.test.ts`.                                                                                          |
| `apps/web/src/server/operations/ai.workflow.unit.test.ts`                           | 2                  | NBC + RC          | Pinned concurrency 5/2, step names, `onItemError`. RC: bulk.unit + builder.unit runtime semantics.                                                                                                                                                                                              |
| `apps/web/src/entity/actions/action-verbs.unit.test.ts`                             | 2                  | NBC               | Distinct-label and destructive-tone-only-for-delete checks over a constant registry. Visible verb behavior retained in `action-verb-ui.unit.test.tsx` and `action-items.unit.test.ts` (verb-backed label/icon single-sourcing).                                                                 |
| `apps/web/src/entity/problem-queries/tracker.unit.test.ts`                          | 1                  | NBC + RC          | Pinned `source.kind`/`continuation` of five declarations. RC: `entity/problem-registry.unit.test.ts` ("gives every definition explicit freshness and a legal continuation", "compiles every exact entity assembly…").                                                                           |
| `packages/schemas/src/test-support/identifiers.unit.test.ts`                        | 3                  | NBC (test helper) | Tested `testEntityId`/`testShortcode` fixture factories; every consuming test fails if they regress.                                                                                                                                                                                            |
| `apps/web/src/lib/test/mock-schema.unit.test.ts`                                    | 9 (some templated) | NBC (test helper) | Tested the `mock()` fixture generator; used by ≥10 suites that parse its output and fail if it regresses.                                                                                                                                                                                       |
| `apps/web/src/server/agents/purchase-import/prompts.unit.test.ts`                   | 2                  | NBC               | Substring pins on prompt wording ("untrusted data", "Never propose receiving"); no model or authority behavior asserted. Authority is enforced by `purchase-import/capabilities.unit.test.ts` and `writer-policy.unit.test.ts`.                                                                 |
| `apps/web/src/integrations/tanstack-query/query-policy.unit.test.ts`                | 2                  | NBC               | Pinned staleTime/gcTime/retry constants. Invalidation behavior retained in `query-freshness`, `catalog-invalidation`, `root-provider`, `operation-tags` suites.                                                                                                                                 |
| `apps/web/src/app/problems/components/add-inventory-dialog.unit.test.tsx`           | 1                  | RC                | Per-feature repeat of "footer button lives in ResponsiveDialog footer (`.border-t.bg-popover`)". RC: `ui/primitives/responsive-dialog.unit.test.tsx` ("keeps the ordinary footer row on desktop", phone header promotion) + `dialog-form-actions.unit.test.tsx`.                                |
| `apps/web/src/app/locations/arrange/ArrangeMoveTo.unit.test.tsx`                    | 1                  | RC                | Same footer-placement repetition; same RC.                                                                                                                                                                                                                                                      |
| `apps/web/src/app/projects/dashboard-filters.unit.test.tsx`                         | 1                  | RC                | Same footer-placement repetition; same RC.                                                                                                                                                                                                                                                      |
| `apps/web/src/app/tasks/create-project-from-tasks-dialog.unit.test.tsx`             | 1                  | RC                | "renders" + `dialog-form-footer` slot placement; same RC.                                                                                                                                                                                                                                       |
| `apps/web/src/features/inventory/inventory-entries-quick-edit-dialog.unit.test.tsx` | 1                  | RC                | Same footer-placement repetition; same RC.                                                                                                                                                                                                                                                      |

## Cases removed from retained files (48 cases)

| File                                                                                                      | Removed                                                                                                                          | Kind              | Proof                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/meals/add-to-meal.unit.test.tsx`                                                                     | footer-placement case (1)                                                                                                        | RC                | ResponsiveDialog primitive tests above; the three AddToMeal behavior cases remain.                                                                                                                                                                                                                                                                                                                                                        |
| `app/docs/docs-registry.unit.test.tsx`                                                                    | "exposes every Markdown file in the docs tree" (1)                                                                               | NBC               | Compared `readdirSync(docs)` to a registry built from `import.meta.glob(docs/**/*.md)` (tautological) plus title/group/default-slug pins. Link resolution test kept; unknown-slug route test kept in `routes/docs.$section.unit.test.ts`.                                                                                                                                                                                                 |
| `app/problems/components/duplicate-spend-section.unit.test.tsx`                                           | "declares coverage…" (1)                                                                                                         | NBC               | Asserted `coverage` defined and `PROBLEM_CLASS` constant. Registration/count/render cases kept; grouping RC in `problem-sections.unit.test.tsx` ("renders every detector key in exactly one section").                                                                                                                                                                                                                                    |
| `entity/actions/action-items.unit.test.ts`                                                                | "declares every action on at least one surface", "keeps every surface non-empty" (2)                                             | NBC               | Non-empty-array pins on a constant registry. Unique ids / one-create-per-entity / verb-backed / createActionFor regressions kept.                                                                                                                                                                                                                                                                                                         |
| `entity/entities.unit.test.ts`                                                                            | `defaultSortFor` describe (2), "takes every pluralLabel verbatim" (1), two literal label pins                                    | NBC + RC          | Default sort pins restate declarations (`entity-list-ssr.unit.test.ts` "matches the route-primary table defaults" covers the resolver). Plural pin duplicated "stamps every routed entity from its own manifest declaration" (kept) plus literal pins; literal-type guard kept as `expectTypeOf` (checked by web typecheck).                                                                                                              |
| `entity/entity-display.task.unit.test.tsx`                                                                | exact column ids, headers, enableSorting, width/mobile, override-own-cell, undeclared override (6)                               | RC                | Per-entity repetition of generic `createEntityDisplayColumns` behavior. RC in `entity/entity-display.unit.test.tsx`: "declared width/format/mobile/sorting" (buckets widths, passes mobile meta, derives enableSorting), "rejects unmatched specialized columns…" and the `Undeclared display renderer for ledgerParty.*` throws. Override-own-cell asserted only the test's own fixture override. Kept: span folding, rich status label. |
| `entity/entity-display.product.unit.test.tsx`                                                             | enableSorting, width/mobile, override-own-cell, undeclared override (4)                                                          | RC                | Same RC. Kept: `ledgerExpectedQuantity` server-composed label.                                                                                                                                                                                                                                                                                                                                                                            |
| `entity/entity-display.recipe.unit.test.tsx`                                                              | exact ids, headers, enableSorting, notes width, second legacy-claim rejection (source), undeclared override (6)                  | RC                | Same RC; legacy-vs-manifest double-claim still covered by the retained costTotal case. Kept: explanation metadata, totalMinutes, pending cost, Source link/row-activation, detail Source renderer.                                                                                                                                                                                                                                        |
| `entity/entity-display.financialTransaction.unit.test.tsx`                                                | enableSorting, width/mobile, override-own-cell, undeclared override (4)                                                          | RC                | Same RC. Kept: generic transactionDate/merchant rendering (it.each).                                                                                                                                                                                                                                                                                                                                                                      |
| `entity/manifest-registries.unit.test.tsx`                                                                | "preserves explicit sentence-case labels for derived garden windows" (1)                                                         | NBC               | Two literal label pins.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `features/entity-platform/EntityManifestGrid.unit.test.tsx`                                               | "marks vendor.runs derived…" (1)                                                                                                 | RC                | Repeat of the "derived" marker already asserted by the retained task.plantings case.                                                                                                                                                                                                                                                                                                                                                      |
| `features/home/HouseCard.unit.test.ts`                                                                    | "gives task and project anchors a phone-sized target" (1)                                                                        | NBC               | `toContain("min-h-11")` on an exported class-string constant.                                                                                                                                                                                                                                                                                                                                                                             |
| `lib/query-freshness.unit.test.ts`                                                                        | "keeps stable details and indexes warm…" (1)                                                                                     | NBC               | staleTime/gcTime/cacheProfile constant pins. Tag invalidation case kept.                                                                                                                                                                                                                                                                                                                                                                  |
| `lib/sub-recipe-reason.unit.test.ts`                                                                      | "names the fix, not just the fact, for every reason" (1)                                                                         | NBC               | Exact-copy pins for five strings. Exhaustive non-empty coverage case kept.                                                                                                                                                                                                                                                                                                                                                                |
| `lib/test/browser-harness.unit.test.tsx`                                                                  | "pins and restores its clock" (1)                                                                                                | NBC (test helper) | Harness clock; consumers using `clock` fail if it regresses. Named regression (unmocked Start transport rejects in-test) kept.                                                                                                                                                                                                                                                                                                            |
| `server/repo/shortcode-resolver-labels.unit.test.ts`                                                      | per-entity "resolves to a non-null column" it.each, "the 7 documented overrides resolve to their documented columns" (2 sources) | NBC + RC          | The file's own docstring: a non-override entity with no derivable column already throws at module init (import-time guard). Override pins restated the override map. Override-not-redundant check kept.                                                                                                                                                                                                                                   |
| `server/operations/recipe-import.workflow.unit.test.ts` → renamed `recipe-import-projection.unit.test.ts` | three step-graph pin cases (3)                                                                                                   | NBC + RC          | Same workflow-runtime RC as deleted workflow files. The two projection/regression cases (committed recipes survive projection failure; settle started image read) kept unchanged.                                                                                                                                                                                                                                                         |
| `ui/hooks/useListBulkActions.unit.test.tsx`                                                               | "offers Copy codes for image now that it has a shortcode" (1)                                                                    | RC                | Repeat of "offers Copy codes on a shortcode entity with no other actions"; image-specific "earns the checkbox column…" kept.                                                                                                                                                                                                                                                                                                              |
| `packages/schemas/src/identifiers.unit.test.ts`                                                           | "keeps the three reasons a derived key would get wrong" (1) + 3 literal label pins                                               | NBC               | Constant pins. Sentence-case/manifest derivation loop and NOT_FOUND mapping kept (`satisfies Record<…, AppErrorReason>` is the compiler guard for existence).                                                                                                                                                                                                                                                                             |
| `packages/schemas/src/native-coverage.unit.test.ts`                                                       | Run agent web-only reason pin, bulkEdit ownedElsewhere pin, collection-verb entity roster pin, all-confirmation-none pin (4)     | NBC               | Declaration value pins. Kept: unsupported ceiling (shrink-only), reason presence, runner-plan coverage, destructive confirmation, Record sale editor parity, row-scope `$item.` check.                                                                                                                                                                                                                                                    |
| `packages/schemas/src/purchase.unit.test.ts`                                                              | "exposes expenseStatus and removes the old lineStatus field", "exposes the structured trio…" (2)                                 | NBC               | `toHaveProperty` declaration pins on generated filter fields; any consumer of a removed key fails typecheck.                                                                                                                                                                                                                                                                                                                              |
| `packages/shared/src/shortcode.unit.test.ts`                                                              | "keeps only the two prefixes that were actually minted" (1)                                                                      | NBC               | `toEqual` pin of the legacy-prefix constant; disjointness/canonicalization cases kept.                                                                                                                                                                                                                                                                                                                                                    |

## Assertion-only trims (no case count change)

- `packages/schemas/src/calendar.unit.test.ts`: removed `expect(MAX_CALENDAR_RANGE_DAYS).toBe(366)` (constant pin); boundary accept/reject cases kept.
- `apps/web/src/server/services/relationship-contract-fixture.unit.test.ts`: case now asserts only that the shared web/Swift fixture parses under the web wire schemas; removed value pins on fixture contents (PRJ/LOC/PRD codes, counts) — those tested the fixture data itself (NBC). The parse is the cross-client contract.

## Considered and kept (not low-signal)

Golden-vector suites (gtin, display-format, household-date, image-url); generated-route/route-template coverage; manifest↔FK/edge/lifecycle consistency guards (`entity-manifest-fk`, `entity-edge-owners`, `entity-edge-operation-policies`, `bindings`); shrink-only registries (`override-registry-shrink`, native ceilings); type-level locks (`removal/core`, `removal/entity`, `operation-domain`, `builder`) — checked by typecheck; AASA app-id pins (Apple wire contract); `view-manifest` saved-view filter specs (product semantics, borderline, left for a later pass); copy-bearing tests where copy selects a state branch (`describeOutcome`, `projectDateDelta`).

## Totals (pass 2 only; prior pass separate above)

- Whole files deleted: 17.
- Files renamed: 1 (`recipe-import.workflow.unit.test.ts` → `recipe-import-projection.unit.test.ts`).
- Test cases deleted: 79 source-level cases (31 in deleted files + 48 in retained files); runtime count is higher because some were `it.each`/templated over entities/schemas.
- Retained files modified: 24 (incl. rename).
- Behavioral protections removed without replacement: none intended; NBC entries had no runtime contract, RC entries name the retained stronger test.

## Validation (pass 2)

- `pnpm exec oxfmt <25 changed test files>` → formatted; `oxfmt --check` clean (≈1s).
- `pnpm exec oxlint <25 changed test files>` → 1 unused-import error found and fixed; rerun clean (≈2s).
- `pnpm test:file <20 changed apps/web test files>` → 20 files / 105 tests passed (26s wall incl. prepare; vitest 16.9s).
- `pnpm --dir packages/schemas exec vitest run src/{calendar,identifiers,native-coverage,purchase}.unit.test.ts` → 4 files / 45 tests passed (≈3s).
- `pnpm --dir packages/shared exec vitest run src/shortcode.unit.test.ts` → 1 file / 142 tests passed (≈1s).
- `pnpm --dir packages/schemas exec tsc --noEmit`, `pnpm --dir packages/shared exec tsc --noEmit` → clean.
- Not run: web typecheck (`typecheck:web:tests`, covers the `expectTypeOf` guard kept in `entities.unit.test.ts`), full unit/ui tiers, knip (deleted tests may leave test-only exports such as `workspaceNavigatorLeavesForTest` untouched — none of the deleted files were sole importers I verified, but knip did not run), lint over the whole repo, E2E, Postgres tier, commits.
