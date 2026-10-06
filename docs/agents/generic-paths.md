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
- Run detail: every Run route (`Route.entityDetail(.run, …)`) opens `RunConsoleView`, the
  declared hero and `run` slots through `DetailSlotRegistry`. Its status follows the batched
  report poll (`ReportBatchModel.status`/`revision`), never a second Run poll. Specialist
  reviews are slots or owned sections of it: a photo Run's review is the `photo-batch` slot
  (`RunPhotoReviewSections` with `.photoReviewConfirmations` on the console's list), led
  ahead of the reports. Successful photo commands advance `RunReviewSession.actionRevision`
  to refresh the report batch even while stopped; ordinary session refreshes never advance it
  or feed back into polling. Never link a Run slot back to the Run screen.
- Edit forms: generated intents plus the typed `editHooks` map in
  `apps/web/src/entity/editing/`.
- Saved views: `presentation.list.views` on the declaration.
- Detail pages: generic detail with declared slots (`app/*/slots.tsx`).
- Slot reports: a slot that is figures, series, a table or dated rows reads
  `entityReport.get` (`server/repo/entity-report/`; block kinds `stats`,
  `chart`, `table`, `schedule`, `note`, `records` in `packages/schemas/src/entity-report.ts`).
  Web draws them with `ReportBlocks` (`entity/entity-detail/report-slot.tsx`),
  native with `ReportDetailSlot`/`ReportPresentation`; add a slot id and a
  builder, never client-side derivation. A `table` block is display text under
  column headings: clients right-align figure columns, open a row's `ref`, link
  shortcodes in cells (web) and say when it is `truncated`. A row that is a
  record of its own (a ledger party) is a `records` row instead, with its kind
  as a neutral `statuses` chip (`badges` read as warnings). A `records` block is rows that are
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
  vocabulary enums (`Generated/EntityVocabulary.swift`) and descriptor types
  (`Generated/EntityDescriptors.swift`, including `ValueSchema`). The typed description in
  `packages/schemas/src/manifest-wire.ts` drives descriptor JSON validation, Swift storage,
  and web structured-value types; `scripts/generator/entities/render/swift-catalog.ts`
  emits the bundle and declarations. Native conveniences stay extensions. The generic list
  and detail views consume that bundle; no hand-written mapping layer.

## Server

- Kernel commands: `executeEntity` / `executeEntityAs`
  (`apps/web/src/server/entity-kernel/execute.ts`).
- Repositories: `defineRepository`, `createEntityReader`, `createEntityCrud`
  (`server/repo/repository.ts`), `declaredFilterPredicates` /
  `listScaffold` (`server/repo/list.ts`; a list read goes through its `list`,
  passing its own `where`, `orderBy`, `select` or `count` instead of calling
  `executeListQueryWithCount`), `insertAndReturn`,
  `updateAndReturn`, `withTransaction`, `formatSearchTerm`, `notDeleted`,
  `buildSearchConditions`, the shortcode resolver, `finalizeMerge`,
  policy-driven removal (`server/repo/removal/`).
- Search fan-out: a record whose search text embeds another entity is one
  `searchDependents` entry (`server/services/mutation-side-effects.ts`) naming
  an explicit query in `server/repo/entity-embedding-cleanup.ts`; it drives
  both the projection refresh and the embedding wave. Writers call
  `runMutationSideEffects(ForEntities)`, or `refreshDerivedSearchRefs` for
  refs captured before an edge is removed.
- Unbounded reads: `listAll` (never a literal huge `pageSize`).
- Money: `cents`, `dollars`, `round2` (`server/repo/money.ts`); expense
  rollups select `expenseAggregateFields` (`server/repo/expense-aggregate-sql.ts`);
  all money is `SUM(Expense.cost)`.
- Postgres errors: `findPgError`, `isUniqueViolation`, `isStatementTimeout`
  (`server/errors/db-errors.ts`) walk Drizzle's `cause` chain.
- Logging and tracing: `createLogger`, `withSpan`/span core
  (`@cubby/worker-tracing`); no raw `console.*` in server or Worker code.
  The logger serializes native Error messages, stacks, causes, and diagnostic
  fields into structured logs, with structural bounds and cycle/getter markers.
  Credential-shaped values are scrubbed; SQL and upstream response diagnostics
  remain visible. `scrubErrorMessage` comes from
  `@cubby/worker-tracing/scrub-error-message`; the web helper re-exports it.
  At the console sink, regression checks assert serialized diagnostic values,
  not native Error instances. When changing this boundary, search every consumer
  assertion across unit and integration tests; capture/callback boundaries still
  receive native errors.
- Retries and waiting: `sleep`, `retryWithBackoff`, `pollUntil`
  (`@cubby/shared/retry`).
  Provider failures retain HTTP status, full upstream response bodies, and
  original causes after bounded retries. UPC partial failures preserve successful
  lookups while carrying the failed provider diagnostic through the batch error.
- Purchase-agent proxy: `server/purchase-import/agent-proxy.ts` forwards the
  caller's abort signal to its Durable Object request. Internal disconnects still
  propagate as failures; cancellation does not replace the Run's abort command.
- Digests, encodings, and casing (browser, Worker, and scripts alike):
  `sha256Hex`, the stable row-id `sha256Uuid` (`@cubby/shared/sha256`);
  `encodeBase64`, `encodeBase64Url`, `decodeBase64Url`, `decodeBase64UrlText`
  (`@cubby/shared/base64`); `capitalize`, `pascalCase`, `humanize`,
  `screamingSnake` (`@cubby/shared/text-case`). Never hand-roll
  `crypto.subtle.digest` + hex or `btoa` alphabet swaps.
- Run operation replay: every `RunOperation` read by key and every write goes
  through `server/repo/run-operation.ts` (`readOperation`, `insertOperation`
  (one row or a batch; `ifAbsent` is `ON CONFLICT DO NOTHING`),
  `insertDebugEventOperations`,
  `reclaimOperation`, `completeOperation`, `setOperationResult`,
  `failOperation`, `failOperationsForRun`); agent tools whose work runs outside
  the ledger transaction use the leased policy `executeLeasedOperation`
  (`server/runs/operation.ts`); writers whose row commits with their business
  writes (purchase prepare, commit, validate, Product enrichment, validation
  corrections) use the atomic policy `executeAtomicOperation` there, which
  replays only a completed row and calls any other "outcome is uncertain".
  Approval and browser-command flows call the primitives directly. Each
  caller chooses the payload its fingerprint hashes:
  the stored rows of paused Runs replay only if each site's key order, the
  `(runId, operationId)` key, and the browser command id stay unchanged.
- Cross-Worker RPC: one Zod contract per boundary, `z.infer` on both sides.
- Purchase-agent typed tools: each tool's parameters are the JSON Schema of
  its entry in `purchaseAgentToolInputs` (`@cubby/schemas/purchase-agent-services`),
  a projection of the host service contract with explicit narrowing; never
  restate a tool input in TypeBox.
- GTIN and barcodes: recipebridge `scan_code_gtin14` and `@cubby/shared/upc`.

## AI

- Model IDs, provider identities, capabilities, role schemas and defaults:
  `packages/shared/src/ai/models.ts`. Derive model lists from those declarations.
- Live pricing: `packages/shared/src/ai/pricing.ts`, through the runtime
  `@opencode-ai/models` client; missing prices stay unknown. Application usage
  estimates live in `server/ai/pricing.ts`.
- Gateway controls, URLs, response observers and transport selection:
  `packages/shared/src/ai/gateway-request.ts`; gateway metadata in
  `ai-gateway-metadata.ts`. Extend these helpers for application and tooling
  callers rather than constructing another gateway path.
- pi-ai provider adapters: `packages/shared/src/ai/pi-providers.ts`.
- Live evaluation support: `apps/web/tooling/ai/eval-support.ts`.

## Web UI

- Dialogs: `WorkflowDialog`, `ResponsiveDialog` + `DialogFormActions`,
  `DeleteEntityDialog` + `useStagedDialogAction`, `LocationMoveDialog`.
- Pickers: `EntityPicker` / `EntityReferencePicker`, `referenceEntitySearch`;
  no direct `ui/combobox` use outside picker builders. A form field binds one
  through `ui/form-utils/entity-value-field.tsx`: `EntityValueField` stores the
  shortcode (assignment forms and dialogs), `EntityItemField` stores the whole
  item (recipe rows, quick add). Both share one binding for validation,
  suggestions, and the selected label.
- Tables: `RTable` and the generic relation table; raw `<table>` only for
  matrices, cross-tabs, and debug views. Column-layout changes go through
  `moveColumn` / `applyColumnLayout` (`ui/data-table/column-layout.ts`), never
  direct `setColumnOrder` / `setColumnPinning` / `column.pin` calls.
- Formatting: `lib/utils` formatters (`formatCurrency`, `formatCount`,
  `formatPercent`, `roundTo`, compact variants) and the WASM amount formatter.
  Currency, bare numbers, amounts, and the compact nutrition cell are one Rust
  implementation (`recipebridge/src/display_format.rs`) shared with native via
  UniFFI; add a rule there and to `golden-vectors/display-format.json`.
- Search results: `features/search/search-utils.tsx` (routes, media, match
  text) and `features/search/product-family.tsx`, the one Product-family
  model (summary, child rows, destinations, keys, disclosure) behind both the
  search page and the command menu. Each surface keeps its own outer element
  and child limit.
- Errors and clipboard: `showErrorToast`, `ErrorDisplay`, `copyTextWithToast`.
- Data: generated query catalog operations, `useActionMutation`,
  `useUpdateMutation`, `useDeletableConfig`, `useAllEntityRecords`.
  Cursor-paged operations use `cursorQueryOptions`
  (`integrations/tanstack-query/cursor-query-options.ts`); numeric
  page/offset paging stays on `infiniteQueryOptions`.
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
- A running Cubby Worker for tests: `apps/web/tooling/workerd-runtime.ts`
  (`openWorkerdRuntime`) under a `WORKERD_PROFILES` profile
  (`apps/web/tooling/workerd-harness.ts`); browser specs wrap it in
  `createE2EWorkerRuntime`. Add a profile rather than assembling a harness.
- Scripts: `scripts/lib/tree-digest.ts` (`walkFiles`, `digestFiles`),
  `scripts/lib/run.ts` (child processes).

## Swift

- `Error.userMessage`, `CubbyClient` list-all helper, `Double.usd`.
  `Diagnostics.report` owns native cancellation filtering; callers pass errors unchanged.
  `CubbyAPIError.unwrapping` preserves transport cancellation identity through generated-client
  wrappers while retaining other transport diagnostics.
- Native loading and failures: `LoadingIndicator`, `LoadFailureView` for an unloaded body,
  `InlineLoadFailure` beside loaded content, and `ActionFailureNotice` for refused writes
  preserve raw diagnostics and caller-owned mutation retry eligibility (`ScreenStyle.swift`).
- Paged, searchable record lists: `GenericEntityListModel` owns paging, de-duplication,
  stale-result discard, retry and the debounced `EntityListSearchModel`. A surface whose rows
  do not come from the declared list route (scoped picker, photo lane, relationship cursor,
  wardrobe) injects an `EntityListPageSource` (contract in its doc comment) and swaps scope with
  `setSource(_:)` instead of keeping its own page/busy/error/generation state.

  Editor picker text uses the declared primary search key before any text-filter fallback,
  preserving date and other dependent scope filters. Pickers preserve stored selection ids and distinct selected/result
  row identities. Native editor pickers select existing records; create-from-picker belongs to
  the web picker workflow. A dependent editor field changes scope after closing and reopening
  its picker; an in-flight source swap is guarded in the shared model.
