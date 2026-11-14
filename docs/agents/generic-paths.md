# Generic paths

Search here before writing a helper, a per-entity branch, or a copy of an
existing block. Extend the generic path when it almost fits. See
[Generic by default](../entities.md#generic-by-default).
Before removing or privatizing a helper or shared export, search every workspace consumer
and retain their behavior checks; passing the helper's own tests proves only that scope.

## Entity spine

- Capabilities: [what each one declares and needs](../entities.md#entity-capabilities).
- Declarations: `packages/schemas/src/entity-definitions/*.entity.ts`, source/read
  construction in `defineEntityModel`, typed relationship factories in
  `relationships.ts`, common field policy in `field-policy.ts`, compiled by
  `apps/web/generator/entities/*`. Record and gallery fields come from `idField` and
  `image-fields.ts`, and a record's images relation from `r.images()`. Raw-read facades import named read schemas
  independently of relationship inference. Relation sections consume one compiled
  scope/create/sort/page plan on web and Apple. A field `display` key is declared once in
  `definition.ts`: the compiled contract and web field model pass it through, and listing
  it in `fieldDisplayWire` (`manifest-wire.ts`) adds it to the Swift descriptor and catalog
  JSON. Entity `presentation` keys reach the compiled contract and web the same way; native
  reshapes them, so a native-visible key adds one wire field and one `presentationJSON` line.
  Generation checks structure; the web/test typecheck verifies those contracts agree.
- Repository SQL titles: `scaffold.title()` reads the stored `titleField`
  column or the repository's declared computed `read.title` expression; shortcode
  labels, graph labels and filter options use it. `read.optionCount` names a
  declared rollup and `read.optionKind` supplies an optional picker kind.
- Reference names and composed display labels: use the typed `display.labelPath`
  contract in [entities](../entities.md), consumed by `readReferenceField` on
  web and `FieldResolutionPresentation.referenceName` on native. Declare
  custom label sources instead of adding suffix guesses to a renderer.
- List columns: field `display` (`standard`, `format`, `readPath`,
  `renderer.list`) compiled by `createEntityDisplayColumns`
  (`apps/web/src/entity/display/entity-display.tsx`); named renderers in
  `apps/web/src/entity/display/list-field-renderers.tsx`. Hand overrides in
  `entity/list-columns/` are only for mutation-bound cells.
- Bulk passes and backlogs: declare the Run kind and its ordered steps once in
  `RUN_KINDS` (`packages/schemas/src/activity-fields.ts`: label, purpose text, unit,
  input mode `count`/`estimate`/`tally`, results family). Executed kinds register one
  driver per step in `server/domains/run/service/run-step-registry.ts`
  (`StepDriversFor<P>`: a `count` step must supply its COUNT); `step-run.ts` freezes
  that population once per step generation and pages it. A step's Retry failed
  pages its re-admitted refs through `pageRetryRefs` in bounded slices without
  moving the population cursor. Scheduled and member-started passes create their
  Run through `ensureRun` (`server/domains/run/repo/ensure-run.ts`). Counts, tallies, no-result reasons, raw errors and Retry failed render through the
  `run.steps` slot. Suggestion families add Sweep steps (`service/sweep.ts`); backlogs
  add maintenance steps (`server/domains/maintenance/service/maintenance-run.ts`). AI
  work uses model Asks; `AskScope` associates waiting scopes and the requesting
  Run, and Answers retain the producer result and `costMicros`, the charged cost
  of the usage rows its produce call wrote (`server/kernel/produce-ledger.ts`).
- Suggestion review: `suggestions_read.list`/`acceptClean` over the family registry
  (`suggestionFamilies` in `server/generic/suggestions/repo/suggestion-family-declarations.ts`)
  and the Suggestions page. Each family's `SuggestionFamilyDeclaration`
  (`suggestion-family-declaration.ts`) declares affected records, actionability,
  presentation and its `apply` handler (`review.ts`). Record scope matches subject records; use the account and vendor filters for related statement suggestions. Web list badges and detail sections
  reuse `entity/suggestions/queue`; automatic history uses `suggestions.automaticDecisions`.
  Never a family-specific review list or a status-only pending count.
- Suggestion publication: every Suggestion publisher declares a
  `SuggestionFamily` and publishes through
  `server/generic/suggestions/repo/suggestion-publication.ts` (slot locks over
  column, `subject.` or `data` fields, suppression, `unapplicable` retirement,
  unchanged match, the family's `replaced` policy, batches of 32 with
  one-at-a-time fallback, label backlog reads). The immutable insert and prune
  are private to it; Run evidence and live answers that occupy no queue slot
  use `publishExactSuggestion`. Family checks plug in as `precheck`/`prepare`
  hooks; never a second lock-and-retire writer.
- Run detail: web renders `GenericEntityDetail` with the declared `run` slots; on Apple
  every Run route (`Route.entityDetail(.run, …)`) opens `RunConsoleView`, the
  declared hero and `run` slots through `DetailSlotRegistry`. Its status follows the batched
  report poll (`ReportBatchModel.status`/`revision`), never a second Run poll. A photo Run
  adds `RunPhotoProgressSection` (upload, descriptions, recovery, Start grouping); its group
  review is web's, so the `photo-batch` slot is a handoff row led ahead of the reports.
  Starting grouping advances `RunConsoleSession.actionRevision` to refresh the report batch
  even while stopped; ordinary session refreshes never advance it or feed back into polling.
  Never link a Run slot back to the Run screen.
- Edit forms: generated intents plus the typed `editHooks` map in
  `apps/web/src/entity/editing/`.
- Saved views: `presentation.list.views` on the declaration.
- Field expected/allowed by a classification: declare
  `capabilities.classificationPolicies` (or a per-row policy column) and read
  `@cubby/schemas/classification-field-policy` plus
  `server/domains/spending-category/repo/classification-field-policy.ts` — never a feature literal at a
  call site. See [entities](../entities.md#classification-field-policies).
- Detail pages: generic detail with declared slots (`features/*/slots.tsx`). Header cells belong to `presentation.detail.summary`: one ordered roster of fields, connected-record previews, concise report projections and charts, capped at eight applicable cells. Reuse the canonical field, relation and report readers instead of adding an entity-specific header query or renderer.
- Slot reports: `entityReport.get` loads domain builders through the generated
  kernel report bindings; `server/generic/entity-report/repo/` executes and composes
  shared server-owned blocks; web `ReportBlocks` and native `ReportDetailSlot`
  render them. [Compiled entities](../entities.md#one-declaration-several-consumers)
  owns block/command/choice semantics. Add a builder rather than deriving figures
  or disabled reasons on a client. Use explicit record/list/selection scopes.
- Workflow commands: opt-in `command` metadata on mutation contracts,
  `operationCommandRequest` for server report construction, and generated
  `workflowCommandOptions` / `CubbyClient.executeCommand` for invocation. Keep
  domain validation in the existing operation handler and writer.
- Swift: declaration-derived native operations and models, one shared URLSession
  transport, `entity-manifest.json`, and the generated manifest
  vocabulary enums (`Generated/EntityVocabulary.swift`) and descriptor types
  (`Generated/EntityDescriptors.swift`, including `ValueSchema`). The typed description in
  `packages/schemas/src/manifest-wire.ts` drives descriptor JSON validation, Swift storage,
  and web structured-value types; `apps/web/generator/entities/render/swift-catalog.ts`
  emits the bundle and declarations. Native conveniences stay extensions. The generic list
  and detail views consume that bundle; no hand-written mapping layer.

## Server

- Purchase and Transaction target eligibility: `server/generic/suggestions/repo/eligible-targets.ts`.

- Kernel commands: `executeEntity` / `executeEntityAs`
  (`apps/web/src/server/entity-kernel/execute.ts`).
- Repositories: `defineRepository`, `createEntityReader`, `createEntityCrud`
  (`server/entity-kernel/repo/repository.ts`); its `createWriter` and `updateWriter`
  own transaction, audit, receipt and reread. Server-only `ENTITY_STORED_WRITES[entity]`
  prepares stored operations from source validation and reference targets; it grants
  no mutation authority, and unsupported mappings need a domain override. Public
  contracts: `@cubby/schemas/entities/<key>`; raw schemas and types:
  `@cubby/schemas/entity-contracts/<key>`; repository validators and compiled read
  schemas: `~/entity/generated/entity-schema-bindings.<key>.gen` (pass those, not the
  aggregate catalog). Full stored rows by ID: `createEntityRowFetcher(table)`.
- Reads: the scaffold owns the repository read port
  ([ADR 0024](../adr/0024-repository-read-declaration.md)): `scaffold.read` for pages,
  `scaffold.get` for detail (detail-only values as `{ scope: "detail" }` bindings),
  `scaffold.getByIds` for the row a writer wrote, and `scaffold.prepareWhere` for a
  filter WHERE outside a page. `listScaffold` (`server/generic/list/repo/list.ts`) takes
  `where`, `orderBy`, plain `select`, relation `load` or joined `count` instead of
  `executeListQueryWithCount`. List filtering, sorting, paging and count share a plain
  root-table FROM, including dashboard counts that reuse list predicates;
  `load(where, projection)` enriches selected IDs only, so never pass list predicates or
  pagination into a relational query. Callers parse complete rows against the canonical
  schema. The [list read contract](../entities.md#list-reads) owns joined row loaders. Nested
  Ingredient Products and Kit components reuse `productScaffold.read`.
- List and query helpers: `compileDeclaredFilters`
  (`server/generic/list/repo/declared-filters.ts`); `defineRelationList` and
  `relationListSearch` (`@cubby/schemas/relation-list`); `WorkSource` and
  `selectWorkCandidates` (`server/generic/work-queue/repo/work-source.ts`);
  `hierarchyDescendantsSql` (`list/repo/hierarchy.ts`) for every recursive descendant
  expansion; `listPrepare` and `declaredRollup` (`list/repo/field-compiler.ts`);
  `related()`/`outer()` (`server/db/helpers/related.ts`) for every other correlated
  lookup; `insertAndReturn`, `updateAndReturn`, `withTransaction`, `formatSearchTerm`,
  `notDeleted`, `buildSearchConditions`, the shortcode resolver, `finalizeMerge`,
  policy-driven removal (`server/generic/removal/repo/`), `galleryBinding(entity)`,
  `vendorLogoKeySql`, `entityMembership(list).has`. `cubby/no-entity-roster` fences new
  entity-keyed maps in generic server code; its baseline only shrinks.
- Search source reads: declare `read.search` (document SQL and embedding
  text) on the owning scaffold. Generic search consumers find the port through
  `kernelScaffold(entity)`, loaded with `await import` because domain
  repositories import them. Stored-quality evaluators live in
  `generic/data-quality/repo/checks/<entity>.ts`; generation wires them into
  `data-quality-entries.gen.ts`. Neither keeps a hand-written roster.
  Semantic artifact validation belongs to `findSimilarEntitiesPage` in
  `generic/embedding/repo/entity-embedding-search.ts`; similarity and identity
  consumers share its bounded seed/hit hydration and current-artifact checks.
- Background execution: `server/kernel/claim.ts` owns claims and retries across dirty scopes,
  Asks and Passes. `server/kernel/pass.ts` owns resumable pages; the hourly derived snapshot
  keeps publication and progress together. Queue delivery and cron invoke the runner directly.
  Runs retain member/agent sessions and history. Provider work precedes the transaction that
  checks current inputs and publishes. `machinery`, `runWork` and `needsYou` read those owners.
  [Background derived data](../entities.md#background-derived-data) owns freshness.
- Evidence, answers and decisions ([ADR 0029](../adr/0029-evidence-facts-and-reconcilers.md)):
  the kernel's one entry `server/kernel/api.ts`. A domain declares `defineEvidence`,
  `defineAsk`, `defineReconciler` and `definePass` in one `defineModule` and adds one line to
  `server/kernel/modules.ts`. Writers call `append` and `decide`; producer calls go through
  `withAsk`; the shared entity writers emit kernel keys themselves and a bespoke writer of a
  column a reconciler reads calls `emitWrites`; money-lane writers use `householdWrite`;
  merges outside a reconcile use `merge`; records resolve through
  `resolveForRead`/`resolveForWrite`; list pages bind `loadMachineryRows`. The kernel runner
  runs dirty scopes, Asks and Passes.
- Unbounded reads: `listAll` (never a literal huge `pageSize`).
- Money: `cents`, `dollars`, `round2` (`@cubby/shared`); expense
  rollups select `expenseAggregateFields` (`server/db/computed/expense-aggregate-sql.ts`);
  all money is `SUM(Expense.cost)`. Actual versus planned (`future`) lines:
  `actualExpense`/`plannedExpense` there, or `actualExpenseSql(alias)` in raw SQL.
- Postgres errors: `findPgError`, `isUniqueViolation`, `isStatementTimeout`
  (`server/errors/db-errors.ts`) walk Drizzle's `cause` chain.
- SQL predicates: use Drizzle `or(...)` for disjunctions. Parenthesize a raw
  SQL `OR` before composing it with `and(...)`; otherwise an update can escape
  its identity predicate through SQL operator precedence.
  `notDeleted(table)` owns declared-table liveness; `notDeleted(alias)` and
  schema-free `liveAliasSql` (`server/lib/live-row.ts`) cover SQL relation
  aliases. Existing SQL-text composers use `liveAliasSqlText` with internal,
  already declared aliases; never interpolate its string into `sql` or
  `drizzle.sql`, which binds it as a value. The liveness lint rule rejects that
  direct interpolation. The raw-predicate baseline retains only that text
  owner and SearchDocument's unqualified partial-index inference predicate.
- Name/alias retrieval: `server/lib/name-alias-match.ts` owns exact keys,
  array-element predicates and set-based identity keys. `resolveNames` uses
  those primitives over declared match columns. Trim lookup input and preserve
  stored names and `lower(column)` indexes. Brand readers retain their existing
  trimmed-stored-value comparison; punctuation/token/substring candidate rules
  remain explicit retrieval policies rather than identity decisions.
- Logging and tracing: `createLogger`, `withSpan`/span core
  (`@cubby/worker-tracing`); no raw `console.*` in server or Worker code.
  The logger serializes native Error messages, stacks, causes, and diagnostic
  fields into structured logs, with structural bounds and cycle/getter markers.
  Credential-shaped values are scrubbed; SQL and upstream response diagnostics
  remain visible. `scrubErrorMessage` comes from
  `@cubby/worker-tracing/scrub-error-message`; the web helper re-exports it.
  Persisted or exposed diagnostics (Run operation/step/dispatch errors, every
  string leaf of a purchase-agent transcript) pass through it at the writer or
  proxy; do not add a second redactor.
  At the console sink, regression checks assert serialized diagnostic values,
  not native Error instances. When changing this boundary, search every consumer
  assertion across unit and integration tests; capture/callback boundaries still
  receive native errors.
- Retries and waiting: `sleep`, `retryWithBackoff`, `pollUntil`
  (`@cubby/shared/retry`).
  Provider failures retain HTTP status, full upstream response bodies, and
  original causes after bounded retries. UPC partial failures preserve successful
  lookups while carrying the failed provider diagnostic through the batch error.
- Purchase-agent proxy: `server/domains/purchase-import/service/agent-proxy.ts` forwards the
  caller's abort signal to its Durable Object request. Internal disconnects still
  propagate as failures; cancellation does not replace the Run's abort command.
- Calendar days: `householdLocalDate`, `householdDateTime`, `householdDaysAgo`/
  `householdDaysFromNow`, `shiftPlainDate`, `plainDateDaysBetween`
  (`lib/household-date.ts`); `householdDaySql`, `householdDaySqlText`, and
  `householdDayRangeConditions` for SQL. `lib/plain-date.ts` adapts plain dates
  to local-midnight `Date`s for pickers and is browser-only. The
  `cubby/no-ad-hoc-calendar-day` lint rule flags `toISOString()` cut to a day
  and server imports of `~/lib/plain-date`.
- Digests, encodings, and casing (browser, Worker, and scripts alike):
  `sha256Hex`, the stable row-id `sha256Uuid` (`@cubby/shared/sha256`);
  `encodeBase64`, `encodeBase64Url`, `decodeBase64Url`, `decodeBase64UrlText`
  (`@cubby/shared/base64`); `capitalize`, `pascalCase`, `humanize`,
  `screamingSnake` (`@cubby/shared/text-case`). Never hand-roll
  `crypto.subtle.digest` + hex or `btoa` alphabet swaps.
- Run purpose behavior: `RUN_KINDS` (`@cubby/schemas/activity-fields`) declares
  each kind's presentation and execution flags (`importReport`, `execution`,
  `aiWork`, `aiWorkProgress`, steps); server code reads those flags instead of
  comparing purpose literals. `server/domains/run/repo/purpose-policy.ts`
  declares each purpose's capabilities, who may control it, which retained mail
  its writers read and whether a successor keeps its parent. Agent-coordinated
  purposes implement `RunPurposeLifecycle` in their own domain (Mail import in
  `purchase-import/repo/mail-run-lifecycle.ts`, photo inventory in
  `photo-import/repo/run/photo-run.ts`), registered in
  `run/repo/purpose-lifecycle.ts`: roster targets, successor handoff, retry
  input, and the cancel, failure, dispatch-failure and admission hooks. Keep
  that registry out of `purpose-policy.ts`: the policy module sits in the
  Worker environment's type graph, and depending on the domain lifecycle
  modules there collapses `Env` inference. Generic Run control calls these
  instead of comparing purpose literals.
- Run lifecycle scope and member-controller snapshots:
  `server/domains/run/repo/control-scope.ts`. Generic control and stale expiry
  must not require a purchase-agent session. Import business-write transactions
  lock the Run before operation locks and recheck live authority before writes;
  completed operation replay stays valid after cancellation.
- Run operation replay: every `RunOperation` read by key and every write goes
  through `server/domains/run/repo/run-operation.ts` (`readOperation`, `insertOperation`
  (one row or a batch; `ifAbsent` is `ON CONFLICT DO NOTHING`),
  `insertDebugEventOperations`,
  `reclaimOperation`, `completeOperation`, `setOperationResult`,
  `failOperation`, `failOperationsForRun`); agent tools whose work runs outside
  the ledger transaction use the leased policy `executeLeasedOperation`
  (`server/domains/run/repo/operation.ts`); writers whose row commits with their business
  writes (purchase prepare, commit, validate, Product enrichment, validation
  corrections) use the atomic policy `executeAtomicOperation` there, which
  replays only a completed row and calls any other "outcome is uncertain".
  Approval and browser-command flows call the primitives directly. Each
  caller chooses the payload its fingerprint hashes:
  the stored rows of paused Runs replay only if each site's key order, the
  `(runId, operationId)` key, and the browser command id stay unchanged.
- Cross-Worker RPC: one Zod contract per boundary, `z.infer` on both sides.
- Purchase-agent typed tools: each tool's parameters are the JSON Schema of
  its entry in `photoInventoryToolInputs` (`@cubby/schemas/purchase-agent-services`);
  never restate a tool input as a hand-written schema.
- GTIN and barcodes: recipebridge `scan_code_gtin14` and `@cubby/shared/upc`.

## AI

- Cost: a new or changed AI call follows
  [ADR 0027](../adr/0027-tier-routed-models-on-a-funding-first-ladder.md):
  fast tier first, one escalation question, flex for unattended work.

- Semantic classification: new or revised judgments about what evidence means
  use a declared Decision feature through `runDecisionChoice`, registered in
  `decisionCatalogRows`. Supply source context, confidence and uncertainty;
  filenames and keywords are model evidence. Keep regexes for structural
  parsing, validation and candidate retrieval. An authoritative supplied value
  or exact protocol match needs no model judgment.

- Decision routing: `decision-model.ts` owns the deterministic text trial choice,
  keyed by feature, prompt version and the complete `buildChoiceInput` result
  before cache lookup. Singleton and batch paths share it. Production wrappers
  never sample or persist a Run, row or snapshot model pin. Preserve explicit
  member grading/replay overrides; media always routes to the vision model.
  Provenance callers use `decisionModelFor` with the same arguments, including
  injected ports (which retain the feature model unless explicitly overridden).

- Prompt requests: `AI_FEATURES` typed `feature.request` renderers; pure prompt
  definitions in `server/ai/policy/prompts/`. `decisionCatalogRows` in
  `server/ai/decision-catalog.ts` owns decision discovery, over the field rows in
  `server/ai/policy/field-decisions.ts`; `AI_FEATURES` owns chat requests. Purchase-import Markdown remains
  authoritative where the request mounts a shared skill; catalog rendering does
  not create another prose prompt.

- Model IDs, provider identities, capabilities, role schemas and defaults:
  `packages/shared/src/ai/models.ts`. Derive model lists from those declarations.
- Live pricing: `packages/shared/src/ai/pricing.ts`, through the runtime
  `@opencode-ai/models` client; missing prices stay unknown. Application usage
  estimates live in `server/ai/pricing.ts`.
- Gateway controls, URLs, response observers and transport selection:
  `packages/shared/src/ai/gateway-request.ts`; gateway metadata in
  `gateway-metadata.ts`. Extend these helpers for application and tooling
  callers rather than constructing another gateway path.
- pi-ai provider adapters: `packages/shared/src/ai/pi-providers.ts`.
- Live evaluation support: `apps/web/tooling/ai/eval-support.ts`.

## Web UI

- Parent-linked in-memory forests: `groupForest` (`apps/web/src/lib/forest.ts`)
  preserves input order and promotes missing-parent rows. Callers own traversal,
  cycle policy and sorting; project folds remain in `project-forest.ts`.

- Icon-only removal: `RemoveButton` (`ui/forms/remove-button.tsx`) requires a label; choose delete only for records.
- Previous/next navigation: `PrevNextButtons` (`ui/navigation/prev-next-buttons.tsx`) accepts optional shortcut metadata.
- Dropdown overflow: `MoreMenuTrigger` (`ui/navigation/more-menu-trigger.tsx`).
- Inline cell save/cancel: `InlineEditActions` (`ui/forms/inline-edit-actions.tsx`).
- Image count and removal overlays: `TileOverlay` (`ui/media/tile-overlay.tsx`).
- Keyboard legends: `KeyHint` (`ui/text/key-hint.tsx`).
- Task checklist counts: `SubtaskProgress` (`features/task/subtask-progress.tsx`).

- Page building blocks: `PageHeader`, `Section`, `Panel`, `Toolbar` and
  `Disclosure` (`ui/layout/`), `KeyNumbers` and `Facts` (`ui/records/`),
  `EmptyState` (`ui/feedback/empty-state.tsx`); DESIGN.md says when to use each.
- Captions and helper paragraphs: `Description` (`ui/text/description.tsx`),
  with its size variant; use `EmptyState` for absent results.
- Keyboard hints: `Kbd` (`ui/primitives/kbd.tsx`) rather than raw `<kbd>`.
- Chart, graph and tree states: `Visualization` (`ui/visualizations/visualization.tsx`).
- Dialogs and workspace panels: `Overlay` (`ui/overlays/overlay.tsx`),
  `DeleteEntityDialog` + `useStagedDialogAction`, `LocationMoveDialog`.
- Numeric inputs: `NumberInput` (`ui/forms/number-input.tsx`) for nullable numeric values, bounds and optional step buttons. Text-draft editors use it unless they need non-numeric input or bespoke validation.
- Pickers: `Picker` for every value choice (`search`, `choose`, `segmented`,
  `multiple`, `suggest`), `EntityReferencePicker`, `referenceEntitySearch`; record rows come
  from `combobox-builders.tsx`'s manifest projection, never hand-built icons.
  A form field binds one through `PickerField`, whose `store` is `option`,
  `id` (the shortcode, assignment forms), `item` (the whole row, recipe lines),
  `name` (the expense vendor), or `ids` (a multiple picker); one binding owns
  validation, suggestions, and the selected record's name and picture.
- Tables: `RTable` and the generic relation table for interactive lists;
  `StaticTable` (`ui/data-table/static-table.tsx`) for simple read-only rows;
  `useLocalTable` for bounded non-entity interactive lists; table atoms for
  matrices, cross-tabs, spanning dependency grids, document content, and loading
  skeletons. Debug reports also use `StaticTable`. Column-layout changes go through
  `moveColumn` / `applyColumnLayout` (`ui/data-table/column-layout.ts`), never
  direct `setColumnOrder` / `setColumnPinning` / `column.pin` calls. Cell
  content that needs a second line uses `StackedValue` (value over muted
  context) or `ChipCluster` (two chip lines, then "+N"); clipped codes and
  paths use `MiddleTruncate`; `useCellSpill` already shows any clipped value.
- Formatting: `lib/number-format` formatters (`formatCurrency`, `formatCount`,
  `formatPercent`, `roundTo`, compact variants) and the WASM amount formatter.
  Currency, bare numbers, amounts, kcal, and estimates (compact cell
  `compactEstimateText`, long form `formatEstimate` in `lib/nutrition-format.ts`)
  are one Rust implementation (`recipebridge/src/display_format.rs`, with
  amounts in `recipebridge/src/parse.rs`) shared with native via UniFFI; add a rule there and to
  `golden-vectors/display-format.json`. Declared list totals arrive as
  server-worded `totalLabels` (`server/generic/list/repo/list-display-labels.ts`); clients
  print them.
- Plurals: `countLabel(count, noun)` from `@cubby/shared/pluralize` for
  "3 nouns", `pluralize(noun, count)` for the noun alone. The
  `cubby/no-hand-rolled-plural` lint rule flags `n === 1 ? "" : "s"` and its
  suffix variants.
- Search results: `entity/presentation/search-utils.tsx` (routes, media, match
  text) and `features/search/product-family.tsx`, the one Product-family
  model (summary, child rows, destinations, keys, disclosure) behind both the
  search page and the command menu. Each surface keeps its own outer element
  and child limit.
- Read-only record lists: `RecordList` (`ui/records/record-list.tsx`) for
  rows, groups with "+N more", folded absences, the Activity/timeline
  variant, and shared trailing formats; `columns` + row `facts` align
  labelled values under one header (inline labels below 40rem). Inline
  labelled values anywhere else: `Facts layout="inline"` (`ui/records/facts.tsx`);
  stacked label/value lists use `Facts layout="list"`. Detail-page connected records read
  `entity.connectedRecordsPreview` once per record;
  relation-table evidence pages use `entity.connectedRecords` per view. Audit
  bursts fold through `foldAuditEntries` (`entity/audit-log/audit-log-fold.ts`).
- Errors and clipboard: `showErrorToast`, `ErrorDisplay`, `copyTextWithToast`.
- Data: generated query catalog operations, `useActionMutation`,
  `useUpdateMutation`, [shared list deletion](../../apps/web/docs/web-runtime.md#react-hooks-preventing-infinite-render-loops),
  `useAllEntityRecords`, and `useServerTree` for a tree entity's whole server-nested hierarchy.
  Cursor-paged operations use `cursorQueryOptions`
  (`integrations/tanstack-query/cursor-query-options.ts`); numeric
  page/offset paging stays on `infiniteQueryOptions`.
- Use `es-toolkit` collection helpers and exhaustive `ts-pattern` matches.

## Tests and tooling

- Entity data: `buildEntity` / `createEntity` and the repo writer variant
  (`apps/web/tooling/factories/`), seeded Faker for filler, `seedBaseWorld`.
  Never hand-parse a `*CreateInput` in a test. Volume-only performance
  fixtures may batch typed stored rows with constraints enabled, canonical bulk
  audit/search writers and real-query read-back. Keep interactive behavior
  scenarios on the kernel; do not use bulk fixture setup as write-path coverage.
- Shared builders: `packages/schemas/src/test-support`; deferreds via
  `Promise.withResolvers()`.
- Import convergence: `apps/web/tooling/convergence-harness.ts`.
- Migration rehearsals: [shared lease and migration folder boundaries](validation-tests.md#migration-rehearsals).
- Disposable IntegreSQL databases: `apps/web/tooling/test-database-lease.ts`
  (`prepareTemplate`, `leaseDatabase`, one template per namespace). Vitest
  keeps `withTestDb`; browser workers use `createE2EDatabase`. A per-test
  fixture whose seed costs more than a clone (~250 ms under parallel load) uses
  `ctx.fixture(key, seed)` (`apps/web/tooling/test-fixture-template.ts`):
  seeded once per run (`ctx.prepareFixture` in `beforeAll`, outside the test
  timeout), cloned per test. Cheaper setup stays in the test body,
  on the per-file DELETE reset.
- The synthetic household: clone the dev corpus template
  (`prepareDevDatabase`, `apps/web/tooling/dev/corpus-template.ts`) rather than
  calling `seedCorpus` again in Vitest.
- A running Cubby Worker for tests: `apps/web/tooling/workerd-runtime.ts`
  (`openWorkerdRuntime`) under a `WORKERD_PROFILES` profile
  (`apps/web/tooling/workerd-harness.ts`); browser specs wrap it in
  `createE2EWorkerRuntime`. Add a profile rather than assembling a harness.
- Scripts: `scripts/lib/tree-digest.ts` (`walkFiles`, `digestFiles`),
  `scripts/lib/run.ts` (child processes).

## Swift

- `Error.userMessage`, `CubbyClient` list-all helper, `Double.usd` / `Decimal.usd` (Rust
  `ValueFormat.currency`; never a Foundation currency style).
  `Diagnostics.report` owns native cancellation filtering; callers pass errors unchanged.
  `CubbyAPIError.unwrapping` preserves transport cancellation identity through generated-client
  wrappers while retaining other transport diagnostics.
- Native loading and failures: `LoadingIndicator`, `LoadFailureView` for an unloaded body,
  `InlineLoadFailure` beside loaded content, and `ActionFailureNotice` for refused writes
  preserve raw diagnostics and caller-owned mutation retry eligibility (`ScreenStyle.swift`).
- Paged, searchable record lists: `GenericEntityListModel` owns paging, de-duplication,
  stale-result discard, retry and the debounced `EntityListSearchModel`. A surface whose rows
  do not come from the declared list route (scoped picker, photo lane, relationship cursor)
  injects an `EntityListPageSource` (contract in its doc comment) and swaps scope with
  `setSource(_:)` instead of keeping its own page/busy/error/generation state.

  Editor picker text uses the declared primary search key before any text-filter fallback,
  preserving date and other dependent scope filters. Pickers preserve stored selection ids and distinct selected/result
  row identities. Native editor pickers select existing records; create-from-picker belongs to
  the web picker workflow. A dependent editor field changes scope after closing and reopening
  its picker; an in-flight source swap is guarded in the shared model.
