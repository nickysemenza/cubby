# Generic paths

Search here before writing a helper, a per-entity branch, or a copy of an
existing block. Extend the generic path when it almost fits. See
[Generic by default](../../AGENTS.md#generic-by-default).

## Entity spine

- Declarations: `packages/schemas/src/entity-definitions/*.entity.ts`, metadata
  schema in `definition.ts`, compiled by `scripts/generator/entities/*`.
- List columns: field `display` (`standard`, `format`, `readPath`,
  `renderer.list`) compiled by `createEntityDisplayColumns`
  (`apps/web/src/entity/entity-display.tsx`); named renderers in
  `apps/web/src/entity/list-field-renderers.tsx`. Hand overrides in
  `entity/list-columns/` are only for mutation-bound cells.
- Edit forms: generated intents plus the typed `editHooks` map in
  `apps/web/src/entity/editing/`.
- Saved views: `presentation.list.views` on the declaration.
- Detail pages: generic detail with declared slots (`app/*/slots.tsx`).
- Slot reports: a slot that is figures, series, a table or dated rows reads
  `entityReport.get` (`server/repo/entity-report/`; block kinds `stats`,
  `chart`, `table`, `schedule`, `note`, `records` in `packages/schemas/src/entity-report.ts`).
  Web draws them with `ReportBlocks` (`entity/entity-detail/report-slot.tsx`),
  native with `ReportDetailSlot`/`ReportPresentation`; add a slot id and a
  builder, never client-side derivation. A `records` block is rows that are
  records of their own (label, thumbnail, badges, a record to open) with verbs
  from `COLLECTION_ACTION_SCOPES`: web fills each verb in
  `entity-detail/collection-actions.tsx`, native runs its plan in
  `nativeCollectionActionPlans` through `HeroActionRunner`. Rows are worded in
  `server/repo/collection-items.ts`. The same block carries the finance slots: rows may be
  checkable (`key`, `disabledReason`), with a `footer` and finance `verbs`
  (`SECTION_ACTION_IDS`, each with the server's `disabledReason`). A verb that edits
  a draft (split, attach expenses, attach products) asks the server before it writes:
  `purchase.checkSplit` / `purchase.checkLinkExpenses` return the body to send or the
  reason not to (`server/repo/purchase-split-draft.ts`, `purchase-link-draft.ts`).
- Swift: generated OpenAPI client, `entity-manifest.json`, the generated manifest
  vocabulary enums (`Generated/EntityVocabulary.swift`, from
  `scripts/generator/entities/render/swift-catalog.ts`), and the generic list
  and detail views; no hand-written mapping layer.

## Server

- Kernel commands: `executeEntity` / `executeEntityAs`
  (`apps/web/src/server/entity-kernel/execute.ts`).
- Repositories: `defineRepository`, `createEntityReader`, `createEntityCrud`
  (`server/repo/repository.ts`), `declaredFilterPredicates` /
  `listScaffold` (`server/repo/list.ts`), `insertAndReturn`,
  `updateAndReturn`, `withTransaction`, `formatSearchTerm`, `notDeleted`,
  `buildSearchConditions`, the shortcode resolver, `finalizeMerge`,
  policy-driven removal (`server/repo/removal/`).
- Unbounded reads: `listAll` (never a literal huge `pageSize`).
- Money: `cents`, `dollars`, `round2` (`server/repo/money.ts`); expense
  rollups select `expenseAggregateFields` (`server/repo/expense-aggregate-sql.ts`);
  all money is `SUM(Expense.cost)`.
- Postgres errors: `findPgError`, `isUniqueViolation`, `isStatementTimeout`
  (`server/errors/db-errors.ts`) walk Drizzle's `cause` chain.
- Logging and tracing: `createLogger`, `withSpan`/span core
  (`@cubby/worker-tracing`); no raw `console.*` in server or Worker code.
- Retries and waiting: `sleep`, `retryWithBackoff`, `pollUntil`
  (`@cubby/shared/retry`).
- Digests, encodings, and casing (browser, Worker, and scripts alike):
  `sha256Hex`, the stable row-id `sha256Uuid` (`@cubby/shared/sha256`);
  `encodeBase64`, `encodeBase64Url`, `decodeBase64Url`, `decodeBase64UrlText`
  (`@cubby/shared/base64`); `capitalize`, `pascalCase`, `humanize`,
  `screamingSnake` (`@cubby/shared/text-case`). Never hand-roll
  `crypto.subtle.digest` + hex or `btoa` alphabet swaps.
- Cross-Worker RPC: one Zod contract per boundary, `z.infer` on both sides.
- GTIN and barcodes: recipebridge `scan_code_gtin14` and `@cubby/shared/upc`.

## Web UI

- Dialogs: `WorkflowDialog`, `ResponsiveDialog` + `DialogFormActions`,
  `DeleteEntityDialog` + `useStagedDialogAction`, `LocationMoveDialog`.
- Pickers: `EntityPicker` / `EntityReferencePicker`, `referenceEntitySearch`;
  no direct `ui/combobox` use outside picker builders.
- Tables: `RTable` and the generic relation table; raw `<table>` only for
  matrices, cross-tabs, and debug views.
- Formatting: `lib/utils` formatters (`formatCurrency`, `formatCount`,
  `formatPercent`, `roundTo`, compact variants) and the WASM amount formatter.
  Currency, bare numbers, amounts, and the compact nutrition cell are one Rust
  implementation (`recipebridge/src/display_format.rs`) shared with native via
  UniFFI; add a rule there and to `golden-vectors/display-format.json`.
- Errors and clipboard: `showErrorToast`, `ErrorDisplay`, `copyTextWithToast`.
- Data: generated query catalog operations, `useActionMutation`,
  `useUpdateMutation`, `useDeletableConfig`, `useAllEntityRecords`.
- Use `es-toolkit` collection helpers and exhaustive `ts-pattern` matches.

## Tests and tooling

- Entity data: `buildEntity` / `createEntity` and the repo writer variant
  (`apps/web/tooling/factories/`), seeded Faker for filler, `seedBaseWorld`.
  Never hand-parse a `*CreateInput` in a test.
- Shared builders: `packages/schemas/src/test-support`; deferreds via
  `Promise.withResolvers()`.
- Import convergence: `apps/web/tooling/convergence-harness.ts`.
- Disposable IntegreSQL databases: `apps/web/tooling/test-database-lease.ts`
  (`prepareTemplate`, `leaseDatabase`, one template per namespace). Vitest
  keeps `withTestDb`; browser workers use `createE2EDatabase`.
- Scripts: `scripts/lib/tree-digest.ts` (`walkFiles`, `digestFiles`),
  `scripts/lib/run.ts` (child processes).

## Swift

- `Error.userMessage`, `CubbyClient` list-all helper, `Double.usd`.
- Paged, searchable record lists: `GenericEntityListModel` owns paging, de-duplication,
  stale-result discard, retry and the debounced `EntityListSearchModel`. A surface whose rows
  do not come from the declared list route (scoped picker, photo lane, relationship cursor,
  wardrobe) injects an `EntityListPageSource` (contract in its doc comment) and swaps scope with
  `setSource(_:)` instead of keeping its own page/busy/error/generation state.
