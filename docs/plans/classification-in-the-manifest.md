# Classification in the manifest — approved brief

Approved 2026-10-09 in a grilling session; base `8b5f861bc` (#1803). One PR.
Terms follow `CONTEXT.md` (Suggestion, Correction, Addition, Miss, Sweep,
Classification policy). Delete this file in the PR once its decisions live in
the owning docs (`docs/entities.md`, `docs/infrastructure.md`, `docs/todos.md`,
`docs/agents/model-routing.md`).

Standing directive: delete code wherever a declaration replaces it and prefer
the generic path; the done report lists every deletion.

## 1. Generated suggestion specs

- Select options declare `description` (meaning) beside `value`/`label`. Move
  the descriptions from `apps/web/src/server/ai/vocabularies.ts` and the inline
  ones in `apps/web/src/server/ai/field-suggest/registry.ts` into the option
  declarations (`packages/schemas/src/entity-definitions/*.entity.ts`,
  `select-control-options.ts`).
- Prompt guidance stays hand-written as `control.suggest.rules` on the field.
- The registry becomes `pnpm generate` output with a drift check. Delete the
  hand registry entries and `vocabularies.ts` contents that the generator
  replaces; keep only a typed hook for genuinely irreducible behavior.
- Docs say "Suggestion"; drop "Jev suggestion"/"proposal"/"Jev registry".

## 2. Classification policies

- Extend `capabilities.classificationPolicies` so the classifier can be a field
  on the governed record itself (today it must be reached through a
  reference). One evaluator (`@cubby/schemas/classification-field-policy`) and
  one SQL generator (`classificationPolicySql`) serve both forms. Generate
  editor hide/fixed-value behavior from `not_allowed`.
- Declare:
  - Expense `lineKind` ≠ `principal`: `productId`, stored `spendingCategoryId`,
    stored `projectId` are `not_allowed`. Effective category and project are
    always the existing split from principal lines
    (`expense-spending-allocation.ts`, `expense-project-allocation.ts`); a
    Purchase with no principal lines keeps the Purchase/Vendor default
    fallback. Display "Follows items" instead of "Unclassified" when the
    principal lines are unclassified. No Suggestions on those fields for
    non-principal lines.
  - Expense `lineBasis = allocation`: `productId` `not_allowed`.
  - Location `type = furniture`: `productId` `required`.
  - GardenEntry `kind`: note → `notes` expected; harvest → `harvestAmount`
    expected.
  - ProductCategory feature on relations: Planting source Product must be
    food; project tool must be a tool-type Product.
- Move SpendingCategory `productExpectation` enforcement
  (`validateProductPolicy`/`validateLiveProductPolicy` in
  `repo/inheritance-validation.ts`) onto the generated policy SQL.
- Existing violating rows surface as data-quality findings; never auto-strip
  household data.
- Delete the restatements this replaces, including: line-kind checks in
  `repo/expense/crud.ts`, `repo/expense/helpers.ts`, `repo/purchase.ts`,
  `repo/purchase-finance-actions.ts`, `repo/expense-inheritance.ts`,
  `purchase-import/writer.ts`, `repo/purchase-import/findings.ts`, the hand
  check in `ai/field-suggest/suggest-fields.ts` (~825), web branches in
  `entity/editing/entity-primitive-fields.tsx`,
  `entity/detail-field-renderers/expense.tsx`, `entity/list-columns/expense.tsx`,
  `features/ai/field-suggestion-provider.tsx`,
  `features/ai/record-suggestions.tsx`; the `hiddenWhen` lineKind rule in
  `16-expense.entity.ts` (keep the `productQuantity` presence rule); furniture
  guards in `repo/location/crud.ts` and the registry exclusion;
  `repo/data-quality/checks/garden-entry.ts`; `productCategoryFeatureCapabilities`
  (`packages/schemas/src/product-category-fields.ts`) and the hard-coded food
  check in `repo/product/classification.ts` `assertProductCategoryChange`.
  Verify each site before deleting; the list came from a search pass.

## 3. Lint

- Flag raw enum string literals for generated vocabularies inside `sql`
  templates (`tools/oxlint/cubby/`).

## 4. Sweep

- A generic paced batch Run: filter, one pinned decision model per Run,
  pacing of a few hundred calls/minute, pause/resume, progress. New Run
  purpose `suggestion_sweep`; stored Suggestion rows (target record, field,
  current value, suggested value, confidence, runner-up, model, status).
- Auto-apply only Additions with confidence ≥ 0.85. Corrections never
  auto-apply; they and everything below threshold queue for review.
- Score a sample of each sweep's targets with both Jev and Clef (paired) and
  record both. Normal decision traffic stays 50/50 (`CLEF_TRAFFIC_SHARE`).
- Manual start only, from the review page (entity/field/filter picker). The
  page notes when the taxonomy revision changed since the last sweep.
- First consumer: Product recategorization.

## 5. Review page

- One generic page over every manifest suggest target: Corrections and
  Additions sorted by confidence; default filter hides confidence < 0.5.
- Accept through the normal update or the reviewed finance apply (Expense
  reach preview).
- Reject records a Miss scoped to its Sweep Run (optionally with the right
  value, which applies). No durable dismissal; the next sweep recomputes. The
  per-record panel's reject records a Miss on that record's `ai_suggest` Run
  and stays a per-visit hide.
- A Misses view grouped by field and suggested value.
- Opt-in billed `eval:decisions` script: replay accepted/rejected Suggestions
  and the paired sample against current prompts, per field and per model.
  Reads live household data; never writes household data into repo fixtures.
- `SuggestionDismissal` stays only for duplicate / tag-propagation /
  related-product recommendations.

## Docs and todos

- `docs/entities.md`: classification-policy section (self-classifier form,
  new declarations; fix the stale category-admission claim).
- `docs/infrastructure.md`: sweep pinning and the paired sample.
- `docs/agents/model-routing.md`: development-routing trial — implementation
  `gpt-6-luna`/medium for an approved brief; Opus/medium for cross-subsystem
  or ambiguous work; review `gpt-6.1-sol`/medium by default, high for
  write-path enforcement, money, migrations, auth; search Haiku 5.5/low
  (confirm the `haiku` alias). Recheck after ~10 PRs (rework, review
  findings, tokens). Distinguish from production research routing (#1803).
- `docs/todos.md`: remove shipped items; fold `evidenceExpectation` into the
  inheritance-chain item (step 3 stays open); drop trade; fix stale
  `expenseProductForbiddenSql` and "delivery receiving gate" wording; add
  "move `backfillImageProcessing` onto the paced batch Run".

## Out of scope

Declared inheritance chains (step 3), image backfill migration, changing the
Jev/Clef traffic share.

## Routing and validation

`gpt-6-luna`/medium implements in its own worktree, in order 1→5; the root
session owns broad validation, the PR, and one `gpt-6.1-sol`/high review
(write-path enforcement moves). Tests: write failing tests first for the
plausible failures (a write path accepting a product on a tax line, an allocation
row with a product, a Correction auto-applied, a rejected Suggestion
resurfacing within the same Sweep); prefer API/E2E per `docs/agents/validation.md`.
