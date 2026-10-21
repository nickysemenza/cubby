# Compiled entities

Cubby's ordinary entity surfaces are compiled from typed TypeScript declarations
in `packages/schemas/src/entity-definitions/*.entity.ts`. Each declaration uses
real Zod schemas for read, create, and update modes. The generator imports these
modules and emits references to the declared schemas; it never serializes Zod
internals or reconstructs refinements.

`definition.ts` owns the strict metadata schemas and their inferred declaration
types. `defineEntity` preserves literals without parsing at runtime and checks
that reference targets and cardinality agree with the branded identifiers in
their read, create, and update schemas. References may project identifiers or
records with a branded `id`; numeric related-record counts remain scalar
projections. Storage-only references need no public schema. The compiler parses
metadata and applies defaults before typed compilation. Cross-entity
references, capability compatibility, field rosters, and physical storage remain
semantic compiler checks. Field-validation Zod instances pass through unchanged.

Declaration loading and artifact generation use the same effective compilation
pass. It captures explicit overrides before deriving image sources and inverse
relations, derives detail sections before validating data-quality placements,
then validates the complete graph against entity and module child storage.
Image routing names actual model fields; disabled create routes do not count as
active alternatives. Counterfactual override comparisons use this same pass.

## Declared board lists

A `kind: "board"` list view configures grouping choices, card fields, intrinsic filters,
per-group caps, page size, ordering and an optional reorder command. `model.grouping`
remains the authority for groupability and filter bindings. Both clients read group
summaries from the full filtered generic list, then query bounded card pages for a
group. A cap limits cards, never the header count. Move and reorder submit one declared
workflow command body to the domain transaction. Clients send neighbor anchors and the
destination group; `task.bulkReorder` calculates sparse ranks over the complete thin group,
rebalancing it only when no rank fits. Rebalancing preserves unseen rows and their timestamps.
Clients do not number a partial page or split a move into writes. Capped recency groups
allow moves between groups but do not offer manual ordering. Task trade grouping uses
the required effective trade; clearing an inherited source must still leave a resolvable
trade. No-value groups without a declared no-value filter remain readable but cannot be placement destinations or manually reordered. No-project placement uses the canonical reference-presence filter. Clearable grouping choices retain their no-value destination even when its count is zero.

Web boards use pointer/touch dragging; keyboard users use the Earlier/Later buttons and Move picker. Drag grips are excluded from keyboard focus and the accessibility tree.

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
- **Reuse before writing.** Search [generic paths](agents/generic-paths.md)
  and the codebase for an existing helper or generic path, and extend it rather
  than fork it.
- **Finish migrations.** A change that introduces a generic path moves every
  caller in the same change. Only a migration too large for one PR records its
  remainder in a shrink-only baseline and a GitHub issue. Lint rules in `tools/oxlint/cubby/` and shrink-only
  boundary tests enforce the common cases.

## Field resolution and overrides

Before adding an inherited value or override, trace an existing field through its
stored intent, effective read, `fieldResolutions` provenance, and declared
`resolution` actions. Reuse that contract for edits, Use inherited, and explicit
None where supported. Domain rules supply the fallback; the generic framework
owns its presentation and assignment intent. Generic form controls alone do not
establish reuse of the resolution framework.

An inherited value has one implementation: the field's `resolution.inherit`
declaration (`packages/schemas/src/entity-definitions/definition.ts`) and its
generator, `server/db/computed/effective-field.ts`. `mode` says when the
row's own stored value decides (absent: NULL inherits; a `none` mode value is
an explicit None); `from` lists the ordered sources, and the first that
decides (a value or an explicit None) ends the chain: `"hierarchy"` is the
nearest live ancestor along `model.hierarchy` whose own value decides
(cycle-guarded, capped at `maxDepth`); `{ hierarchy: { whileSame } }` is that
walk stopped at the first ancestor whose effective `whileSame` field differs
from the row's; and `{ path }` the effective value of the field a to-one path
ends at. Project assignee, locations and default trade, product category
feature, spending mapping and stock tracking, and task project, subject
product and assignee walk their hierarchy; the task assignee then falls back
to its effective project's default, and a Product's stock tracking reads its
category's (ADR 0013). Task trade walks only ancestors on the task's
effective project (`whileSame: "projectId"`), then reads that project's
default trade.

`effectiveFieldSql` is the value every read, list row, filter, sort and group
uses; `inheritedFieldSql` the fallback; `effectiveSourceSql` and
`inheritedSourceSql` the record that decided the value or the fallback,
which `fieldResolutions.sourceEntity` names; `inheritanceLadderSql` every
record a hierarchy chain reads, for "why this value" explanations, ending
at the ancestor a `whileSame` walk stops at (`eligible` false). A stored
filter over an inherited field, a `via` path ending at one, and a relation
edge whose foreign key is one all read the effective value (a batched
traversal that walks such an edge toward its source may join a statement-local
relation of each row's effective value, so the match is an equality join
rather than a per-pair walk); an unconditional hierarchy-only
chain filters in the top-down set form (`effectiveFieldInSql`), resolved once
per query. Repositories format provenance labels and nothing else; never
hand-write an ancestor walk or fallback for a declared field.

These fields keep their own resolution because their rule is not
inheritance, or would need more than a small step kind (#2616):

- Expense `projectId` and `trade`: only principal lines resolve (other lines
  read no project, or their own trade); a Purchase's default project counts
  only when that Project is live (its default trade needs only a live
  Purchase); and a food line's last project fallback is a
  classification policy, the designated household Project chosen by
  shortcode when the Product's category feature is food. The allocation
  join form (`principalExpenseInheritanceSql`) must equal the scalar one.
  Declaring them needs a row gate, per-step conditions and a fixed-record
  step.
- Expense `spendingCategoryId`: a ladder of override, vendor food context,
  category mapping, purchase and vendor defaults whose category step reads
  draft values projected into the walk for review previews.
- Inventory `ownerLedgerPartyId`: resolved in JS from acquisition evidence.
- Product `price`: a derived kit or expense price, not inherited.
- Recipe `servings`: derived from the record's own yield when measured in
  servings (`resolveRecipeServingValue`, shared with older embedded reads).
- Purchase and financial transaction `itemizationExpectation`: a policy
  ladder across vendor and category.

Project subtree expansion has two forms. A caller that needs only ids reads
`loadProjectSubtreeIds` (`hierarchyDescendantsSql`, the list filter's
expansion). A caller that already loaded the project tree for its rows,
estimates, rollups or date windows walks that tree with
`collectDescendantIds` instead of a second query; project tree pages walk
their filtered children map, which is not the stored hierarchy.
A set-valued fallback is outside `resolution.inherit`:
Purchase `paymentAccounts` stores only explicit `purchasePaymentAccount` links
and otherwise derives its accounts on read from payment evidence
(`purchasePayingAccountIdsSql`), like derived funding beside explicit
Expense attribution.

A new field is complete when its normal reads and supported filters/sorts agree
on the effective value, reset restores inheritance, and source changes update
inherited values while preserving explicit choices. Extend the shared contract
when a required state is missing rather than adding a parallel override path.

## Detail summary data

`presentation.detail.hero.stats` selects up to four readable field keys. The
resolved keys live in `entitySummary[entity].detail.hero.stats`; their field
metadata and values use the same field model and detail read as the rest of the
page. No separate summary query or entity-specific stat map is needed.

`detail.hero.chart: { kind: "monthlyExpenseSpend", viewKey }` selects an existing
connection view (or `relation:<key>`). Every path must end at Expense. The
`entity.monthlyExpenseSpend` read returns the current household calendar month
and eleven predecessors, oldest first, zero-filled. It sums distinct live actual
Expense costs (including credits), rounds dollars to cents after summing, and
excludes planned lines. Location charts describe stored products' expense
history through the declared connection, not expenses incurred at that location.

`detail.activityRelations: [{ relation, dateField }]` opts traversable many
relations into `entity.detailActivity`. The date must be a stored date or
timestamp on the target; undated records are absent. Audits of the source record
join the selected records before sorting and cursor pagination. The entity filter
applies to both record and change events. Record ids deduplicate multiple paths;
only Expense events carry `amountCents`. Cursors preserve database timestamp
precision and use the event id to break ties. Data-only web consumers use
`useMonthlyExpenseSpend` and `useDetailActivity` in
`apps/web/src/entity/entity-detail/use-detail-data.ts`.

## Declaration contracts

Compiled default fact sections reuse the declaration's edit groups, with
remaining read-only coverage and summaries grouped afterward; a record's own
facts come before workflow slots. These synthesized groups explicitly use the
Overview workspace, independently of the legacy `overviewSections` IDs used by
native overview metadata; otherwise new edit-group IDs would fall into Evidence
after workflow sections. Explicit detail sections retain their order and declared
workspace. Web detail renders every section in one full-width
column in declaration order — there is no supporting rail. A section's
`placement` is `primary` (shares a ruled plane with its neighbors) or `full`
(its own plane); journal presentations keep their relation-first ordering. Web identity/media composition follows
[the web design contract](../apps/web/DESIGN.md); galleries remain their own section.

`presentation.recordIconEntityField` names a read-only projection containing an
entity key. Generic web and Apple record surfaces resolve that entity's declared
icon, falling back to the record's own entity icon for missing or unknown keys.
Record emoji and real media keep their existing precedence; navigation still uses
the entity's stable type icon. Runs project `iconEntity` on both ordinary entity
reads and Activity reads: the subject's entity wins, AI work can use its ledger
party, and otherwise the purpose selects the entity the work concerns. Status
and execution device do not change identity. This projection is not stored.

Declarations may import shared primitives and cycle-safe field modules. They
must not import canonical schemas, generated artifacts, server implementations,
or browser modules. Implementation references remain `{ module, export }` data.
Browser metadata is generated separately and contains no executable schemas.
Static generator inputs also cannot execute schemas that consume generated
output: install runs generation before those files exist. Shared presentation
vocabulary such as `activity-fields.ts` owns primitive enums and labels so runtime
and native generation share exhaustive labels without a bootstrap cycle.
Cross-client input limits live in bootstrap-safe `shared/client-constants.ts`;
native constant rendering must not import an identifier-dependent input schema.
The generator emits the AST-derived shortcode registry before importing read-schema
compilers and renderers. Declaration source paths and errors live independently
of compiler initialization so fresh-checkout generation needs no prior artifacts.
Declaration helpers such as pagination import shared constants from their leaf
owners, because the shared barrel also loads generated shortcode schemas.
Existing specialist list columns declare `route.listColumns: { module, export }`;
the generated index route passes that synchronous override to `listPage`. Its
component split owns the import, so other entities do not load that specialist
code. The test-only override roster preserves hook-stability coverage and the
shrink-only boundary; new columns still belong in the generic declaration.

Generated detail and list type maps derive from their schema maps, preserving
the entity key's input/output correlation. These schema-contract artifacts remain
separate from browser metadata and executable server bindings.
An oxlint `no-restricted-imports` override on the declarations and the helper
modules they import protects this boundary (`.oxlintrc.json`); a helper a
declaration newly imports joins that override's file list. Shared identifier
and field primitives compose domain projections without importing generated
schema maps.

Run:

```bash
pnpm generate
pnpm check:clean
```

One generator (`apps/web/generator/main.ts`) writes the entity artifacts first
(`apps/web/generator/entities/`), then the artifacts derived from the operation
contracts: the operation registry, handler loaders, the browser client catalog
that resolves each contract's cache tags and invalidation data
(`apps/web/generator/start-operations/`), and the HTTP OpenAPI document with its
native derivations (`apps/web/generator/http-api/`). Generation fails on invalid
metadata, duplicate entity keys or routes, invalid relation policies, and
unsupported capabilities. Generated files are never committed:
`pnpm check:clean` proves a generate run leaves the tree unchanged. Typecheck
verifies declaration types and referenced exports.

Progressive list enrichment reuses one exported error schema across entities,
so OpenAPI and Swift emit one shared error type while each entity retains its
own successful enrichment shape. Base-list responses likewise share one
metadata schema, so each entity uses the same pagination and grouping type.

## One declaration, several consumers

Each declaration co-locates schemas and field policy. Use an existing
ordinary declaration in `packages/schemas/src/entity-definitions/` as the
working example and `definition.ts` for accepted metadata; a prose copy of
the full declaration shape would drift from the compiler.

The exact accepted keys are enforced by the compiler. Source references name a
module and export; they do not import implementations into the declaration. `fields.detail`
is optional and falls back to `fields.output`; declare it when the current
detail read carries enriched relations or computed fields.

`presentation` is everything a generic surface needs to _present_ the entity
and nothing a surface computes: `titleField` (a read-projection key — the
compiler rejects one that is not) must resolve to a **non-nullable** text read
field; the compiler rejects a nullable title. An entity whose natural title
can be empty (no name column, or a name that may be blank) instead declares a
storage-less read-only `displayName` field — `validation: { read: z.string(),
create: null, update: null }`, absent from both `storage` and every
`intents.fields` roster — computed in the repo mapper from other columns, and
points `titleField` at that field. `planting`, `gardenEntry`, `meal`,
`financialTransaction`, `purchase`, `inventory`, and `vendorAccount` all use
this pattern today. `domain` (a `WAYFINDING_DOMAINS` line or
`null` for an entity on no line), `description`, `emptyState` copy, and icon
names (`phosphor` is checked against the browser registry's icon map at compile
time; `sfSymbol` reaches the native catalog verbatim). The generator emits it
as part of `entitySummary` (`packages/schemas/src/generated/entity-summary.gen.ts`,
data only, safe for eagerly-loaded client code), spreads it into the inspector,
and writes `domain`/`sfSymbol` onto the Swift `EntityDescriptor`. The summary
also carries the resolved `primarySearch` (the declared one, else
`searchQuery` for a searchable entity with a contract) and the `bulkUpdate`
field roster, from the same generator helpers the inspector uses
(`apps/web/generator/entities/render/shared.ts`). `bulkUpdate` and `entityFieldModels[entity].bulk` share the compiler-derived
normal-update roster and the exclusions in the bulk edit contract below. Navigation
grouping, the Records catalog, empty states and the native shell's sections
all read it; none of them keep a per-entity list of their own.

`presentation.detail`, `.list` and `.edit` are the one declaration both the
web and the native renderers draw from. A `*Override` name is reserved for a
value that replaces a default the compiler computes; an additive or required
declaration (`detail.additionalSections`, `list.views`, `list.totals`,
`route.list`, `route.detail`) takes a plain name. The generator compiles each
override without it and refuses one that changes nothing, so the Schema tab's
override table lists only live deviations. `detail.hero` names the chip (an
enum/boolean field), stat fields, a breadcrumb reference field, and `when` (a
date or timestamp field, optional `label`) for when the thing happened, shown
through the field's own renderer ahead of the ingest `createdAt`, which it
replaces as the leading time and falls back to when empty; hero images follow
the gallery capability. Actions derive from capabilities: the hero gets
`edit` with an update contract, and a list gets `bulkEdit` (bulk update),
`merge` (kernel merge), and `delete` (kernel delete). `hero.extraActions` and
`list.extraActions` add workflow verbs ahead of those.
Web record-level slot actions render once in the detail header through
`DetailActionTarget` (`apps/web/src/entity/entity-detail/detail-action-bar.tsx`).
Collection verbs derive from the declared sections and `reportSlotActions`;
the typed header hook registry supplies specialist workflow controls.
Registry declarations preserve each
entity's record type; generic JSX dispatch erases both the component and its
record at one documented boundary, matching the existing detail-slot renderer.
The header owns component lifetime, so switching Overview, Relations, or a
dedicated tab does not remove controls or abandon an open dialog. Section consumers use `DetailAction` to retain local
controls only when rendered outside the full detail page. Report header reads
reuse the section cache and the existing Run batch poll; they do not add a
separate Run query. Agent controls reuse their existing cached work read;
walkthrough controls and automatic/guided generation share one mutation gate
per recipe and observe the latest generation outcome, so another surface cannot
launch competing generation or leave a stale failure after a successful retry. `reportDetailActions` explicitly identifies record-level
report commands and diagnostic rows, leaving approvals, selections, recipe
scales, per-row imports, guided regeneration, ownership confirmations, and other contextual work
beside its evidence. Finance verbs with `scope: "section"` use the header;
`scope: "selection"` verbs stay with the checked rows and their disabled reasons.
Vendor search and product indexing controls observe the same cached job/readiness
state as their worklists. Stored URLs, source mail links, map coordinates, and
linked entity/identifier values remain facts rather than header actions.

`detail.sectionOverrides` replaces the inferred Overview section with an ordered list of
`fields` (a named subset of the `display.detail` fields — every such field is
placed exactly once), `relation` (the target entity's list filtered by an
id/idMulti descriptor on the target whose `brandRef` points back here, with
optional `columns`/`sort`/`limit`), `timeline` (the entity's timeline
capability) and `slot` (the one per-platform hand-written fill, rendered
only where a registry provides it — `DetailSlotId<E>` / `ListSlotId<E>` in
`entity-manifest.ts` type those registries). Full record relation sections stay visible after an empty first read on web and Apple, with a secondary heading, explicit Empty cue and usable create action. Full-detail visibility and folding flags are absent from the declaration and generated catalogs. Pagination and show-more behavior remain declaration-owned.

Run import report eligibility comes from `IMPORT_REPORT_RUN_PURPOSES` in the
shared Run schema, including `mail_import`. Web and server use its shared
predicate; Swift reads its generated constant. This is presentation, not
execution authority: agent-coordinated purposes include photo inventory and
exclude historical file imports, while discovery and the Imports saved view
have their own deliberately different scopes. A photo batch keeps its own
review and durable transcript rather than purchase report sections. Its review
snapshot shares one current image-evidence read between proposal cross-checks,
the photo list, and lifecycle readiness. Reuse lasts only for that read; the
next refresh observes newly settled image work and proposal edits. Image analysis
summaries and rich description provenance share `loadImageAnalysisEvidence`,
which selects source-fenced descriptions and member corrections once.
Summary-only consumers project from the same read. Local-analysis summaries
select the newest live row per requested Image in SQL, using descending IDs
for equal timestamps, and transfer only classifications and recognized text.
Missing keys keep their defaults; explicit null or malformed newest evidence
contributes no local summary rather than reviving an older row. Full payloads
and historical rows remain in retained storage.

Expense analytical reads use `server/domains/expense/repo/expense-derived-read.ts`: a declared
scope and SQL projection batch share one materialized allocation relation.
Compatible charts, analyzer grids and facets consume that relation in one
statement; distinct date scopes remain separate. Ledger selection, search,
related views, contributions and project rollups use the same owner rather
than correlated allocation calculations per output row. Selection limits the
purchases to resolve, while every live principal sibling supplies the
denominator. Stored Expense list predicates narrow that relational selection
before allocation membership; quality and caller-supplied derived conditions
remain outside it. Reads without stored constraints keep the whole-ledger path.
Trade and cost-type scopes do not request spending-category resolution unless
the projection or another scope uses categories; trade inheritance remains
available independently of category resolution.
Membership projects Expense IDs from matching shares without aggregating costs
or resolving Project output unless its scope needs Projects. Trade inheritance
still follows the canonical Project policy even when Project output is omitted.
Prepared ledger selections remain SQL relations through batching;
wrapping their IDs in `ARRAY(SELECT ...)` hides broad cardinality and causes
repeated allocation scans. Analytical callers use `expenseSelectionForWhere`;
batch contexts accept relational selections or literal IDs, never SQL arrays.
Literal ID batches retain indexed array membership; legacy correlated arrays
remain available for bounded record/search reads. Scope filters apply to rounded shares, unknown costs stay null,
and unscoped totals sum original Expense costs. Quality hydration declares a
bounded derived relation for its selected ID batch, sharing category gaps and
exception evidence; single-record search refreshes restrict that relation too.
Unclassified receipt roles keep one unresolved allocation with the original
signed amount; they never enter adjustment weighting. Role completeness is
reported separately from amount completeness.

Broad Work queue Product filters explicitly request statement-local on-hand
stock evidence through the shared read context. One grouped inventory/location
relation preserves the canonical absent, mixed-unit and installed-stock rules;
record-scoped queue and ordinary Product reads retain indexed scalar lookups.
Unsupported evidence fields fall back to their canonical reads, and unused
relations are omitted.
Positive-stock applicability guards resolve unavailable stock to false before
kit or ledger-quantity reads; the underlying quantity stays null.

Entity reports declare lazy dependencies in `server/generic/entity-report/repo/`.
Each batch memoizes dependency promises by declaration identity, preserving
slot order, duplicates, cursors and status. Distinct slots share compatible
project trees and scopes, record identities, Purchase finance inputs and Run
headers. Member-gated histories resolve viewer membership before record identity,
preserving the authorization error when both inputs are invalid. Project analytics supplies the budget summary when both are requested;
budget alone does not load charts. Reuse ends with the batch: there is no
cross-request cache or encompassing transaction. Cheap identity/status dependencies stay separate from
reference, quality and content hydration. Slot loaders request the projection
they render and reuse broader reads only when another requested slot needs them.
Purchase finance slots select the batch's union of scalar finance inputs, sharing
signed Expense spend and one canonical financial aggregate scan (including posted
refund evidence for reconciliation). Allocation alone skips financial aggregates;
settlement alone skips vendor reconciliation inputs. Images, quality, category
summaries, references and coverage stay with explicit full-detail readers.
Settlement predicates use existence checks when they only need to know whether
live evidence is present. Exception fingerprints include raw comparison totals;
equal rounded cents alone do not establish fingerprint compatibility.
Run report headers select purpose/status; non-import Runs skip import detail,
and standalone timelines select public operation metadata without result bodies.
Full import slots share their detail and its operation evidence within the batch.

The full-filter Product price footer groups live sibling quantities and
visited kit-ancestor Expenses. Page-sized scalar pricing keeps its correlated
path: small-fixture grouping regressed, and a scalar/batch SQL CASE made the
broad query much slower. Preserve values, signed money and full sibling
weights when revisiting either path; measure broad and one-leaf populations
separately rather than generalizing a synthetic speedup to production.

**Report slots.** A `slot` section whose content is figures, a chart series, a
table or dated schedule rows has no per-platform code: the server composes it
once (`entityReport.get`, builders in `server/generic/entity-report/repo/`, block kinds
in `packages/schemas/src/entity-report.ts`) and web (`ReportBlocks`) and native
(`ReportDetailSlot`, Swift Charts) only draw it. `entityReport.get` accepts an
explicit `record`, filtered `list`, or bounded `selection` scope in a POST body.
Each builder validates its supported entity, filters, and cursor; unsupported
scopes fail rather than falling through to a record read. Portfolio analytics
reuse the domain allocation query and sum selected scope roots once; task
briefings reuse the bounded, ranked Today projection. Add the slot id to
`reportSlots`, a builder, and the appropriate declaration or collection surface;
money in a report is `SUM(Expense.cost)` or the persisted valuation, never
recomputed on a client. Money summaries and chart labels preserve cents, matching
the report rows. Linked record names truncate within the available row width,
leaving trailing amounts visible on phones. The finance slots (purchase
reconciliation, project allocation and financial settlement, expense settlement,
statement-charge
search) also use the `records` block: rows a person can open or check, plus the
verbs that act on them (`SECTION_ACTION_IDS`). Each row's and verb's
`disabledReason`, every amount and the footer are the server's; a verb runs an
existing operation on each client that implements it, and any a client lacks is
classified under `sectionAction` in `native-coverage.ts` (none today). Split,
attach expenses and attach products keep their rules on the server too:
`purchase.splitStart` and `purchase.checkSplit` (a name each, whole cents that
add up to the original exactly, one product part, an attribution choice, and the
body to write), `purchase.linkExpenseCandidates` and `purchase.checkLinkExpenses`
(scopes, wording, the resulting total, and the confirmation when expenses would
move off another purchase), `purchase.linkProductCandidates` (a search minus the
explicitly attached). The write re-validates; a refused check sends no write.

When an indexed section supplies a report block’s heading, its nested renderer omits that heading so the section has one title and one accessible region name.

**Report commands and batching.** A `records` row may carry `badges` (toned chips), `lines` (an
untoned line is the row's result, `muted` lines its evidence, and an optional
`ref` opens its context record), a `trailing` figure, an `externalLink` (label
and HTTP(S) URL), a collapsible `detail` and `commands`. Ordinary commands name
an existing mutation operation and its exact body. The mutation contract's
opt-in `command` metadata owns shared operands, confirmation, and result
presentation. `operationCommandRequest` checks server construction against the
operation input; generated web/native dispatch invokes that same operation and
its cache policy. Both clients confirm before sending when copy is declared.
Form bindings replace only declared operands; frozen evidence, fingerprints,
and approval bodies remain part of the domain request, and the writer validates
them again. Cookbook chunk loops and interactive device/review adapters retain
their domain protocols. Command presentation adds no workflow executor or new
business-rule language.
A report may say the record is `live` (clients poll; there is no realtime transport), carry its
`status` (a client showing another refreshes its record) and a `nextCursor` for paging. A page that
shows several slots of one record (a Run) polls one `entityReport.getMany`, so the server loads the
record once per poll.

**Run work progress.** The storage-only `getRunWorkProgress` projection supplies
both `imports_read.run_status.workProgress` and the Run's shared `progress`
report block. Every Run purpose declares a count source: step receipts,
target outcomes, operations, images, model calls, or its typed checkpoint.
Exploratory populations have `total: null`, never an invented zero. Step drivers
can declare phase and units; the runtime persists absolute samples in RunStep
metadata, preserving completed phases across pages and Workflow attempts.
The shared report labels the current-phase ETA explicitly. Capacity and retry
waits identify their activity and mark a reused rate as stale; later phases do
not acquire an overall ETA from the current phase's throughput.
The Run list exposes `workProgress` and `activityAt` as read-only derived
fields. Its hydration batches step receipts across the page and reuses the
detail calculation; other purposes use their persisted samples, so row counters
can lag the detail's live counters. The list never
requests a work snapshot per row or infers throughput from timeline frequency.
Activity is the latest recorded progress, step update, or heartbeat. A missing
sample remains unavailable, and stale/paused samples do not read as live rates.
Other Run checkpoints and progress events retain samples in live-progress
metadata; samples use the checkpoint write time, while heartbeat-only events
do not refresh a work sample. Timeline history
retains its small event payload. Legacy records start sampling from their next
checkpoint without rewriting earlier history. A missing first-phase total and
earlier completed work can be recovered from the existing step ledger at read
time; later phase totals are never inferred from mixed-phase counters. Statement
generation counts the scoped candidate charges once at the start of the pass
and carries that existing count across handoffs, including pre-sample work;
progress adds no repeated candidate-count query. Account resolution can exclude
some candidates during generation; those still count as scanned charges.
Mail Runs with no stored roster
report an unknown total; progress delivery does not invent sources or change
Mail membership validation. Target counts reuse the roster's
latest applicable outcomes, and photo preparation includes device failures.
Live reads resolve current outcomes rather than serving a cached count; Mail
import, product enrichment, and purchase validation admit at most 50 sources
per Run.
Processed means succeeded, skipped, and failed; failures remain separately
visible. Generation charges and label suggestions never share a percentage.
Retries clear terminal samples and failure counts immediately, then reset
sampling while retaining a compatible phase/unit rate. ETA uses
that rate only with a known total; paused or stale estimates identify the reused
rate and last progress time. Unknown totals show counts and a rate without a
finish time. Web and Apple draw the same server-composed summary and estimate.
Consecutive successful Workflow starts fold into one expandable timeline entry;
phase changes and errors stay separate, and stored events are retained.

**Derived relationships.** A relationship whose provenance is `derived` is
inferred from stored evidence rather than one FK path and stores nothing of its
own (ADR 0011). It names the target's list filter descriptor that answers
"records related to this one"; a relation section, HTTP, MCP and native read it
through that filter, and the graph walker, delete policy and FK manifest test
skip it. Purchase, Vendor and Vendor Account declare `emails` this way, and
Ledger Party declares `purchases` over Purchase's effective `purchaserId`
filter; a derived section uses the filter its relation names.

**Emails sections.** Purchase, Vendor and Vendor Account detail embed the Email
list scoped by its `purchaseId`, `vendorId` or `vendorAccountId` filter, one
row per Email. Each row carries `purchaseLinks` (every related Purchase in
scope with its state) and the scope-relative `linkState`: accepted import
sources and reviewed links are Linked, then live suggestions (an exact order
id, or a matching total within 45 household days when either side lacks an
order id — never a nearby date alone), then Dismissed; a Vendor's sender-proof
mail with no Purchase reads "No Purchase match". The section sorts by that
state, newest first. Inside a Purchase's section, the row menu's Link and
Dismiss review the pair; only the Email's owner (`ownedByViewer`) may, and an
import-accepted source cannot be dismissed. A Link that replaces another
Purchase's link on the same order events asks first. Each decision keeps who
proposed the link (member, agent, import or the suggestion heuristic), and the
Emails Accuracy view counts dismissed proposals per proposer. The Email page
holds the Gmail original, per-Purchase links with Link/Dismiss, and changed-
since-review warnings; another member's Email reads as metadata only.
Accepted-source association reads use the canonical root and alias indexes;
an Email's family lookup must not scan unrelated accepted mailbox history.

**Report choices.** A `records` row may carry a `choice` (a decision the person makes) and the block
a `form` (its own choices, the progress wording, a `disabledReason` and the one command the answers
unlock). The server words every label, ranks the `suggestions` (a prepared line's Product
candidates), says what is `required` and never preselects an answer: identity is chosen by the
person. An option may also ask for a pick, a reason, or a Distinct-from Source (`url` and `quote`)
per listed record; "Create a new Product" lists the exact-name and identity-review candidates the
commit guard would otherwise refuse. A client records answers and asks the shared rules whether each is complete
(`packages/schemas/src/report-choice.ts`, mirrored by CubbyKit's `ReportChoiceAnswers`), then sends
the body those answers assemble (`commitPreparedInput`) with a fresh operation id per answer change.
`run.import-prepared-orders` is the first user.

**Native coverage.** Which of these presentation ids the Apple app does not draw
is declared once, in `packages/schemas/src/native-coverage.ts`: every control,
list, and detail renderer id, hero action, and (entity-qualified) detail and
list slot has a status (`implemented`, `generic`, `ownedElsewhere`, or
`unsupported` with a reason). The records are typed against the generated id
unions, `native-coverage.unit.test.ts` fails when a new declared id is
unclassified, and `NATIVE_UNSUPPORTED_CEILING` pins the per-kind unsupported
count so the set only shrinks. `pnpm generate` writes it to the CubbyKit bundle
as `native-coverage.json`, which `NativePresentationCoverage` reads. To add a
web-only renderer, slot, or action, classify it `unsupported` and raise the
ceiling with a justification in review; to close a gap, build the native view
path, flip the status, and lower the ceiling.

**Structured values.** A field whose control renderer is in
`STRUCTURED_VALUE_RENDERERS` (`external-ids`, `label-nutrition`,
`source-aliases`, `source-refs`, `unit-mappings`), or a `structured-field` marked `implemented` in
`nativeCoverage.structuredField`,
is an object or array of objects that **both clients edit with one generic editor** over the same
generated description: CubbyKit's `StructuredValueControl` and web's `StructuredValueField`
(`apps/web/src/entity/editing/structured-value-field.tsx`, which binds existing form primitives to
nested react-hook-form paths; the older bespoke product and finance editors stay where they exist). A
field joins only with a read-to-input vector in
`packages/shared/golden-vectors/structured-roundtrip.json` (web parses it with the input schema;
`StructuredValue.swift` and `structured-value.ts` both project and shape the read to that input).
The `structured-field` vectors are generated: `structured-field-vectors.integration.test.ts` (and
`recipe-sections-vector.integration.test.ts`) write a synthetic record through the real server, read
it back, and fail unless the stabilized payload equals the vector's `read` and the web editor's
projection equals its `input`. Where a read payload nests what the input names flat, the input
field declares `.meta({ readFrom: "ingredient.id" })`: the generator emits it as the field's
`readPath` for `StructuredValue.project`, and `structured-value.ts` applies the same path.
`pnpm generate` derives the `valueSchema` from the field's Zod input schema (`update`, else `create`;
a create-only field such as a meal's `recipes` draws on create alone;
`apps/web/generator/entities/render/value-schema.ts`) and writes it to the Swift manifest and to
`generated/structured-value-schemas.gen.ts` (web imports it only from the editor): nullable text,
number, boolean, enum, shortcode reference (a pattern that names an entity prefix), amount
(`{value, unit}`), constants, objects, arrays, maps over an enum of keys, and variants over a
literal key; `.meta({ opaque: true })` marks a key carried untouched and never shown,
including nullable enum/text siblings edited through declared scalar projections.
A variant
starts with no case chosen, so a new account must pick its identity kind. Validation stays
server-side: issues land at `GenericEntityEditModel.nestedError(key, path:)` on native and at the
nested form path on web. A new structured field needs only its Zod input schema, a renderer in that
list or a `structuredField` entry, and a vector, never per-entity UI.

The descriptor wire shape is declared once in `packages/schemas/src/manifest-wire.ts`:
property types, Swift associated-value labels (`_0` for unlabelled payloads), raw enums,
conformances, and public initializer defaults. `structured-value-schema.ts` derives web types
from it; the native catalog generator validates its JSON and emits `EntityDescriptors.swift`,
including recursive `ValueSchema`. Synthesized Codable still owns encoding and decoding;
optionals and initializer defaults stay distinct, and the catalog stays bundled JSON to avoid
the Release compiler stall from a giant Swift literal. `LabeledOption.color` is retained
in both web and native descriptors and resolves to the shared adaptive palette. Computed
native conveniences remain extensions in `Manifest/EntityManifest.swift`.

A source claim is edited under the identity its read exposes: the read carries `sourceKey` (a hash
of the provider id or the evidence, so the provider id is unrecoverable) and the input accepts it
(`ledgerSourceClaimInput.sourceKey`, opaque, exclusive with `providerId`). The server
(`resolveClaimKeys`) refuses a key the record does not hold and a request that resolves two claims
to one identity. A held key survives an evidence edit when it is provider-keyed (re-hashing the
stored evidence does not reproduce it, so the provider id still resolves to this claim); an
evidence-keyed claim is re-hashed to its new key in the same replacement. A kept key keeps the
stored `sourceKeyVersion`. `.meta({ createOnly: true })` on a value (an account's identity kind;
the server refuses a change too) locks it on edit, and `.meta({ notice })` shows a caution with it.

An `implemented` hero action also needs a plan in `nativeHeroActionPlans` (same
file, emitted as `heroActionPlan`): the declared verb maps to one generated
operation (flag its contract member `native:`), an input form, and a
confirmation (`destructive` for delete and discard). The native
`HeroActionRunner` executes every plan, and `pnpm generate` fails when the
operation is not on the generated client or the body names a field the
operation does not declare. A server `*Preview` query supplies any
"what will this do" text (`product.discardPreview`, `entity.connections` for
delete), so web and native show the same verdict. A list/multi-select verb
(`bulkEdit`) is `ownedElsewhere`, not a plan.

A section or slot can declare `workspace: "overview" | "work" | "evidence"` for browser detail grouping. Relations default to Work, timelines to Evidence, and other sections to Overview. The Relations group holds the generated Connected records section (every entry in `connectedViews`, read through one `entity.connectedRecordsPreview`) ahead of Relationships. Every group and body renders continuously; navigation scrolls to stable sections and preserves mounted drafts. Full detail headings and index entries stay present while loading and after a section becomes empty. The old group fragments remain jump aliases; a real section ID takes precedence if it matches an alias. Explicit jumps add history; scrolling only updates the highlighted entry. Photo comparison grids respond to their own width so the outline cannot squeeze identity evidence into a zero-width column. Apple retains native record fields and native Contents navigation; Connections uses the shared hosted workspace. The Run evidence pilot renders only the shared Evidence group in its isolated hosted surface. Durable transcript and structured logs remain available for every Run purpose; purchase-import predicates apply only to workflow reports. Workspace vocabulary is presentation metadata, separate from SQL enums.

`detail.overviewSections` still emits independent `overview` metadata for web and Swift. On full web detail, sections that set `overview: false` join Evidence unless their declaration explicitly chooses another group. The native Contents outline follows the native record's reading order; all section bodies remain visible.

Relation tables are opt-out. Every `many` relation on a generic detail page
renders a table: a declared `relation` section, or one the compiler derives
(`apps/web/generator/entities/derive.ts`) with `derived: true`,
the target's default columns. Empty derived sections remain visible and open. The derived
section finds its filter on the target: the only id/idMulti descriptor whose
`brandRef` names this entity and that no other section on the page already
uses, or, among several, the one over the relation's own FK column. A
self-relation (a product's kits vs. its components) only ever matches by FK
column, because a lone branded filter can scope the opposite direction. When
nothing resolves, generation fails until the relation gets a declared section
or an entry in `detail.omitRelations: { <relation>: "<reason>" }`. A relation
whose target has no list page is recorded there automatically. The coverage
invariant lives in `apps/web/tooling/entity-relation-coverage.unit.test.ts`.

Inverse relations are opt-out too. A `one` relation over a single outgoing FK
(`Planting.taskId`) gives its target a derived `many` inverse
(`task.plantings`, labelled with the source's plural) unless the target
already declares one over the same path or the relation sets
`inverseOmit: "<reason>"`. A `many` relation over a single incoming FK gets a
stored `idMulti` back-filter on its target when none names this entity, so
the generated predicate serves it without repository code. Every
idMulti filter declares a `brandRef`, so its URL values stay shortcode-native
and related-view filters stay usable as back-filters.
A relation section's create button seeds the descriptor's field on the new
record: the descriptor key itself when it is a create field there, otherwise
the one reference field on the target whose `reference.entity` equals the
descriptor's `brandRef.entity` — one generic rule instead of a per-entity
seed hack. When more than one field could carry that identity, or the writable
field is a multiple reference, the section declares `prefill: { field }`; the
compiler verifies that the field is writable on create and references the
section owner. Web and
native relation renderers consume the same generated prefill rather than
guessing from field names. `history`, `relationships` and
`images` are derived from capabilities and never declared. `list.views` names
the renderers (`table`, `shelf`, `timeline`, or a `slot` view with its
route-only `searchKeys`); the first is the default and the generated search
schema carries `view` when there is more than one. `list.links` names the
header links. `list.timeline` names the date fields and
lifecycle keys the default timeline emits. `lifecycle.start` accepts either a
single field key or an ordered array of them — an interval's start is the
first field in that order with a non-null value, so a fallback field can
supply the start when the primary one was never set (e.g. planting's
`["sowedOn", "transplantedOn"]`: a nursery-bought seedling has no `sowedOn`,
so its interval starts at `transplantedOn`). The default timeline marks such
a row as inferred (`confident: false`) whenever a fallback key, not the
first one, supplied the start. `edit.sections` (`[{ id, title, fields,
collapsed? }]`) declares the editor's titled sections. The compiler emits the
complete list: every controlled field of the create/update rosters and edit
intents that no section names joins an untitled `main` section, which leads
unless a bare `{ id: "main" }` entry places it, and no field appears twice.
The web `EntityIntentFields` and the native `GenericEntityEditModel` render
that list as is, with no fallback grouping of their own. The image-block keys
(`pendingImageIds`, `pendingImagePurposes`, `removeImageIds`, `imageOrder`)
stay out, since the editors' image block owns them on both platforms.
`presentation.spans` (`[{ start, end, label }]`, date fields only) declares a
start/optional-end pair. Web lists fold it into the start field's row through
`DateDisplay` and `formatDateSpan` (full date plus relative context outside tables;
compact stacked day/distance inside tables, per [web UI contracts](../apps/web/docs/web-ui.md))
and hide the end field. Web details and inspectors show both endpoints as
independently editable, human-readable dates with their contextual quality
results. The editor rejects an end before its start; the native catalog's
`editDateRanges` is generated from the declaration. `capabilities.timeline`
(`"default"`: audit log plus the declared date fields; `"custom"`: the
`extensions.ports.timeline` implementation) publishes the
entity on `entity.timeline`. The compiler checks every named field,
relation, descriptor, view and section id.

Every listable entity receives the shared List (`table`) and Cards (`shelf`)
presentations without requiring stored photos. Existing first-view defaults
remain unchanged. Cards use the declared title and `list.shelfSubtitleOverride`
fields, falling back to declared mobile subtitle metadata when no shelf
caption is specified; missing captions stay absent. `list.titleSubtitle: true` puts the same
caption under the table's identity column as a muted second line inside the
32px row (Vendor, Purchase, Product, Inventory and Expense opt in). Server-resolved display
images are reused, with an entity icon when no image is available. Exceptional
list projections use explicit adapters rather than per-card detail requests.
Compact is the same card presentation with screen-local density state, not a
stored preference or a URL parameter. Web list chrome carries that same state
across the phone header boundary, where controls render outside the route subtree.
Shared web and Swift grid components own
tile sizing; declarations own record-specific presentation facts. All three
presentations retain the list's query, filters, sort, and pagination. Bulk
selection and editing are available only in List.
`list.viewAliases` preserves retired view URLs by mapping them to a current
renderer. `list.primarySearch` declares exceptional list search inputs without
claiming that the entity participates in global search (for example USDA's
`nameFilter`). Native read metadata distinguishes generated resource readers
from explicitly declared read-RPC adapters; it does not expand `httpActions`.

### Bulk edit

Every entity with a normal update contract supports `entity.bulkUpdate` through
one runtime. The compiler derives the field roster from normal update fields;
there is no entity or field bulk opt-in. Names, external identifiers (including
barcodes, retailer SKUs and ASINs), images/attachments, and one-to-one links are
excluded by declaration metadata. `display.standard`, image references, and
unique single-column foreign-key indexes supply the existing semantics;
`semanticRole: "externalIdentifier" | "attachment"` marks ambiguous fields.
Shareable references remain editable.

The web `bulkEdit` action and MCP expose that same roster. The web dialog uses
normal intent controls, unchanged/set/clear assignment modes, and submits only
touched fields. Nullable scalar controls share the form's empty `null` baseline;
initialization or resetting another field must never stage a clear. Explicit
`false` and nullable clears survive. Value collections
such as tags and aliases, and multi-reference lists such as Task blockers,
accept only `[{ op: "add" | "remove", key: "…" }]`;
replacement arrays and rename operations are refused. Each row retains its
unrelated values, additions deduplicate, and removing an absent value is a no-op.
Resolved values pass the normal update schema, including object refinements.

Every top-level list receives this patch contract from its normal input schema,
including structured arrays. A declared `collection.key` identifies record items:
`{ op: "add", key: { purchaseId: "PUR-ABCD" }, value: { amount: 6 } }` adds one
allocation; remove supplies only that key. Adding a held identity with different
attributes is refused; remove then add expresses that change. Without a named
record identity, the complete item value identifies it; generated UUIDs and
opaque read identities are excluded from that comparison. Structured reads project
through the normal input description, including nested `readFrom` references.
`collection.readPath` declares an authoritative projection when the detail uses a
different shape, such as Wish candidates. An unavailable collection read refuses
the batch instead of treating it as empty.

Every exposed field has a usable normal editor control. Only assignment mode
companions are folded into their owning value controls; bulk rendering never
silently omits a genuine update field.
Structured additions and removals use the normal editor's wire normalization;
empty optional lists are omitted. The dialog sends removals before additions so
a held keyed item can change atomically, and labels removal controls visibly.

Execution is atomic across the selection (1–500 unique public IDs). Ordinary
stored scalar columns use one set-based UPDATE when the normal writer's
`updatePolicy.recordFields` dependencies permit it; reference resolution,
collections, compound values, and opaque/domain writers use the normal
single-record update for every row in the same transaction. This policy describes
normal write work, not a second editable-field roster. Shared CRUD updates read
the live table row for scalar before-state and audit diffs; explicit relation
hooks own collection snapshots. Full detail hydration runs only when the
requested mutation output needs it. Per-row audit, CalDAV
guards, assignment/dependency resolution, recipe costing, search projections,
and suggestion supersession follow the normal mutation contract. A failure rolls
back every row and pending publication; diagnostics retain the failing row or
selected rows and raw database details, including SQLSTATE 23505 on a unique
collision. Location reparenting retains Home and cycle checks; the arrange
workflow's larger envelope delegates to the same runtime. Native has no bulk
update route or multi-select delete UI.

`capabilities.images` is `false`, `"gallery"` (an ordered `<Entity>Image` join
table, bound in `apps/web/src/server/db/helpers/crud.ts`
`imageJoinBindings`, whose keys are checked against `GalleryEntity`),
`"cover"` (a single `coverImageId` column, cookbook), or `"logo"` (a single
direct logo FK, vendor). The source-only `entity-definitions/image-associations.ts`
facet owns association targets and their storage modes; entity declarations and
Image validators consume it directly, without generated policy imports.
The manifest keeps the storage boolean `hasImages`
(`gallery`/`cover`) alongside `imageStorage`. Every public entity list and
detail read carries server-resolved `displayImages: [{ id, url }]`; details
also carry directly owned `attachments` with their role and position.

Image-ingress bindings use `source-id` for a singular reference target and
`source-id-list` for a multiple reference target. Both are compiled against the
declared reference cardinality; no image workflow branches on a domain field
name to decide whether the source identity is wrapped in an array.

Related display images stand in when a record has none of its own. An entity
with image storage declares `capabilities.images.displaySources`; there is no
default to replace. An entity without storage borrows from a ranked singular
outgoing relation to an Image or image-storing subject (direct Image
references first); `displaySourceOverrides` replaces that derived ranking and
`[]` opts out. The schema rejects the other name for each kind. The compiler does not borrow through incoming activity or
recursively consume another entity's resolved `displayImages`. The centralized
resolver in `apps/web/src/server/entity-kernel/repo/entity-display-image.ts` orders direct
displayable images before related images, filters unavailable files, and
deduplicates by image ID. Web and native clients render the first result and do
not derive their own cover.

`extensions.ports` is the explicit seam map for entity-wide behavior the
compiler must not infer: the kernel repository binding, entity label and
shortcode resolver, filter declaration, and search-document
projection/text/refresh hooks. Each entry is a
`{ module, export }` source reference or `null` when that port is intentionally
absent or remains a workflow-only seam. Mutable relationships declare their
typed item schema, repository adapter, source, and browser/MCP exposure on the
relationship itself. The generated inspector projects these references as
client-safe data; generated server bindings import executable adapters.
Repository closures still own transactions and service injection.
For entities using the shared search-document behavior, `ports.search: "document"`
selects the standard projection, semantic text, and dependent refresh bindings;
use explicit references when an entity needs a different implementation.
Search presentation branches use current shared kind values; retired kind names
must not survive as label conditions in SQL.

The model owns scalar validation and physical column factories as well as
presentation. `model.storage` declares stored columns; `create`, `update`,
`output` and `audit` select fields for their respective consumers.
`defineEntity` constructs the raw `readSchemas.output`, `list`, and `detail`
objects once. Simple declarations share one base object; domain composers passed
as its second argument extend or narrow that base in declaration-safe schema
owners. Product keeps its richer food/detail composition, Location keeps its
recursive detail shape, and Recipe keeps its lean list. Canonical public exports
and generated wrappers reuse those instances; relationship and domain schema
literals have one owner. `model.output` selects the base fields, not the complete
list/detail roster. Generated field maps still select create/update/read
validators by key, retaining their original Zod instances.

The base constructor owns the synthesized `dataQuality` field. Its composer
facts include the declaration's own check-ID enum, built by the same
`ownDataCheckSchema` helper used by the global generated check catalog. A raw
composer never imports generated field maps or the generated quality registry.
Public list/detail consumers and the compiler apply the existing media
decorators after declarations initialize; those decorators do not belong in
`defineEntity`, whose Image dependency would cycle.

Generic MCP inputs reuse the canonical create/update contracts. MCP output
contracts name their audience-specific projections explicitly, which can extend
canonical outputs; specialized tool digests retain their own projections.

Use ordinary Zod composition for shared rules; spell out each mode:

```ts
model: {
  fields: [{
    key: "name",
    kind: "text",
    control: { kind: "text" },
    validation: {
      read: z.string(),
      create: z.string().trim().min(1),
      update: z.string().trim().min(1).optional(),
    },
  }],
  storage: ["name"],
  create: ["name"], update: ["name"], output: ["name"],
  audit: ["name"],
}
```

Field defaults are non-nullable, a label derived from the camel-case key, and a
read key equal to that key. Use `labelOverride` for a different label and
`readKeyOverride: null` for fields without a scalar read
projection. Missing controls expose no editor. Omitted display flags derive
from each effective surface schema: the value or reference identity must exist
and have a supported rendering strategy. A read key or reference declaration
alone does not establish availability. Explicit `false` omits an eligible field;
explicit `true` cannot admit an unavailable field. Default-equal flags, labels,
read keys, column IDs, and list orders fail shared compilation. Fields consumed
as another field's label or item list default to hidden on both surfaces, so
helper projections do not become duplicate facts. Other deliberate omissions
remain explicit. A reference defaults to one entity. A label defaults to the humanized key (a reference
drops its `Id`; a `<field>Presence` filter field reads "<Field> present").
Explicit labels, nullability, read keys, and renderers override these
defaults. Declaration inputs use `display.columnIdOverride` and
`listOrderOverride` when a rendered field needs a different identity or list
order. The compiled manifest retains `columnId`, `detailOrder` (title first,
then model order), and `listOrder`.

Use **reference name** for the human name of a linked record and **display
label** for composed presentation text. A reference normally projects
`<stem>Name` or a nested record's `name`. A custom display label must declare
`display.labelPath`; both web and native reference renderers read that path
before the conventional name and preserve the target's identity. Never put an
identifier in a label projection. `defineEntity` checks simple declarations' label and detail-label paths at
TypeScript compile time. Shared compilation validates every displayed path
against its actual decorated list/detail schema, including
nested properties and array projections. Compile-only schema contracts use
`*.typecheck.ts` entry points in Knip and run through the schema TypeScript
check without being imported by the application. The generator also rejects custom
`<stem>Label` / `<stem>DisplayLabel` companions without a declared label path.

A reference may declare `multiple: true` and an ordered `scope` mapping. Each
scope item maps a sibling form `sourceField` to a filter `targetField` on the
referenced entity. The compiler verifies both ends and generated editors wait
until every scoped source has a value before querying, so an incomplete form
does not accidentally widen the candidate set. Scope constrains discovery,
not stored values: existing selections remain visible and can be removed even
when another field changes and they no longer match the candidate query.

Generic entity filter-option rosters use the shortcode when the stored display
name is null or the computed title has no stored display column. Page ordering,
search, and selected-value hydration use that same label, without loading full
entity records.

`control.suggest: { basis, mode }` marks a field whose value the decision tier
(Jev/Clef trial) infers from named sibling fields, so the browser editor can auto-fill it
while untouched and offer a one-tap apply once a value already exists. `basis`
names model field keys on the same entity only — never an `intents.editorFields`
pseudo field, since detail/table/bulk surfaces have no editor-field data to
read. `mode: "fill"` (the default) targets a select-controlled enum, a singular
(non-multiple) reference, or a nullable text field (a roster-backed name, e.g.
`expense.vendor`); the compiler rejects anything else, a basis key that doesn't
resolve to a model field, a basis key naming the field itself, and any cycle in
the basis → target edges across an entity's suggest fields, so one request can
always resolve every target in dependency order.
Enum targets may declare `allowNone: true` to offer an evaluated decline when
their basis does not support a value. A decline proposes no replacement or
clearing of the current field; exhaustive enums keep `allowNone: false`.

A suggest target with no physical column declares `backedBy`: same-record
stored columns with `{ column }`, or referenced-record columns with
`{ entity, column, via }`. The generator validates those names and rejects any
derived target without backing columns. Derived DDL supersedes pending
suggestions when a backing column changes; referenced backing watches every
target row linked through `via`.

Shared AI selection sends the entire shown roster to the decision model only when it fits
both the 254-choice limit and the 32,000-byte serialized UTF-8 envelope,
including subject, rules, labels, and the none option. Otherwise the fast chat
tier selects from that same roster with explicit candidate ids, even when its
labels are positional; an unshown candidate id resolves to null.

`mode: "prune"` targets a `text-array` field instead (the compiler rejects any
other kind) and proposes _removals_ rather than a value: entries whose value
restates one of the named `basis` fields (a manufacturer name, a classification
path segment) are candidates to drop, never to add. A prune target judges its
own current entries, so it is an implicit self-basis — naming it explicitly in
`basis` is still an error, but the client and server both fold the target's own
current value into the resolved basis automatically, JSON-encoded since the
value is an array. The resulting `FieldSuggestion` carries
`operation: "remove"` and a `removals[]` list instead of a plain `value`; the
generic review surfaces render it as a removal proposal, never an auto-apply,
and a form-mode `FieldSuggestionProvider` skips prune targets by default
(record surfaces — list/detail — request them). Prune acceptance verifies the saved remaining array and records the same saved-field Feedback receipt as a set proposal; removed tokens are not compared with the remaining value.

The generated `suggestFieldKeys` tuple
(`packages/schemas/src/generated/entity-field-model.gen.ts`) lists every
declared `"entity.field"` suggest target, and its `GeneratedSuggestFieldKey`
union type-enforces that the server's field-suggest declarations
(`server/ai/policy/field-suggest.ts`) and runtime registry
(`server/ai/field-suggest/registry.ts`, which adds rosters and candidates)
each carry exactly one entry per key.

Assessments store immutable typed subjects, judgments, evidence and nullable original producer metadata. Assessment and Feedback child handles accept the full PostgreSQL GUID shape, including retained hash-derived identifiers with arbitrary UUID version/variant bits; readers, review commands and receipts preserve them exactly. Entity, Run and observation identifiers keep their own stricter contracts. Successful applications commit an immutable command-bound Feedback receipt with the domain write. Explicit single and batch finance Apply acknowledge each Assessment only after the finance writer saves; recording the saved default preserves any newer draft. An identical command replays its receipt before current projection checks; conflicting operation reuse is rejected and another command cannot inherit a resolved application. Public operation IDs reserve internal receipt namespaces; replay validates the immutable receipt kind, exact command Feedback binding and recorded outcome. Feedback records correct, wrong, uncertain and presentation-only dismissal separately, with an explicit correction-presence discriminator so corrected JSON null survives. AssessmentState holds rebuildable current targets, field supersession, confirmed values and exactly scoped suppression. Merges and deletes change these projections, never historical subjects. Live field inference shares one immutable publication per subject, full evidence, exact proposal and served model/prompt policy, preserving the first actual producer and proposal across requesting Runs. Live and stored inference also share an internal review identity over the actual captured feature, prompt, model, policy dependencies, field subject, exact proposed value and operation kind. An exact wrong review remains resolved across either entry point until evidence, policy or candidate changes; unknown legacy evidence receives no invented identity. It retains history with an inactive projection; only stored sweep advice enters the queue. A wrong review resolves that exact evidence and served policy without declaring universal value suppression; revised evidence or policy can be assessed again. Runs are nullable provenance references rather than history owners. The family registry validates current projection targets. Email link authority can target the real retained `orderMailEvent` internally when its Email is absent; that target is never a public entity, shortcode, search, or HTTP resource. Email removal repoints link authority to the event and retires relevance projections. Event deletion or supersession retires current link authority while immutable history survives.

Assessment review identity and Feedback admission reads select only their
required identity or served-status fields; immutable evidence is loaded only
by the family action that consumes it. Large retained snapshots must not be
transferred by generic history or review plumbing.
Canonical fingerprint serialization traverses validated JSON directly, sorting
object keys while preserving array order and JSON scalar encoding; it must not
revalidate or clone each nested subtree. Normalize dates and optional values at
the input boundary before serialization.

All five review families use this storage: fields, Email relevance and event/Purchase links, image descriptions, Product pairs, and generic recommendations. `assessment.review` and `assessment.reviewBatch` (MCP `entity.review_assessment` and `entity.review_assessments`) settle immutable review independently of apply intent. Each batch item has its own outcome. Draft acceptance records history; saved application has a separate transaction-bound receipt. Current-evidence and domain-authority checks fence field writes, Email corrections and pair merges. Email link application revalidates its expected active Assessment and current target after Purchase, Original and Email locks, so a waiting review cannot replace newer authority. Relevance application requires an explicit domain-supported related or uncertain correction before recording Feedback; unrelated grading remains history-only. Unserved model trials stay outside member review.

A new bare wrong verdict is a Miss, without suppressing future evidence. It resolves the current Problem, and canonical publication of the same pair evidence and decision policy preserves that review. Relevant evidence or policy revisions may publish a fresh Assessment. Publication identity excludes requesting Run and execution IDs; the first actual producer and evidence snapshot remain immutable. Exact command retries replay the same receipt; conflicting operation-ID reuse is refused. Legacy ambiguous reject/dismiss outcomes remain ungraded, retaining their original field-value, pair, recommendation-group, relatedness or tag-preference suppression. Existing corrected values and explicit labels retain their recorded semantics. Field applications keep existing AuditLog receipts and distinguish automatic acceptance from explicit member acceptance. New evaluation-only Email grades never change routing; frozen sample rosters retain original predictions, strata and inclusion probabilities.

Confirmed image descriptions remain authoritative in display, classification and search even without generated analysis. Image-analysis retries publish the first retained result for that exact analysis identity; a later response cannot replace immutable Assessment evidence or confirmed text. Live description authority disappears with the Image; history and inactive confirmation times survive. Current field targets and declared inputs supersede pending Assessments through both generated Postgres triggers and kernel invalidation. Historical byte hashes, model versions, provenance and actor intent are never reconstructed.

Product identity retrieval and triage run through existing Run-backed AiEvaluation work, gated by AI refresh activation. A resumable cursor covers every live Product, with explicit miscellaneous exclusions counted as coverage. Exact identifier retrieval is independent of name/model gates; semantic similarity and model verdicts are candidate evidence. Reads use stored pair Assessments. Current nonnull model disagreements and retained historical identity conflicts block pair application, including weak recommendations. Equal current model strings or research notes do not verify identity or clear historical conflicts; uncertain variant matches remain pending review. An explicit merge can supersede historical advice only after identity inputs differ from every retained conflicting comparison, with current conflicts rechecked transactionally. Automatic matching remains blocked; notes do not unlock it. With exact identifier admission they become identity-conflict Problems. Raw receipt SKUs retain unknown variant granularity and remain ranking evidence even with matching size, color and pack; explicit ASINs can establish exact identity. Uncorroborated title text and partial selected variants remain ranking evidence. Connected pairs may share one Problem presentation, but each merge names exactly one independently assessed pair and rechecks its evidence. Merging and survivor image ordering commit together. Stock combines; duplicate receiving is a separate reviewed inventory correction.

The deployed AI refresh manifest compares exact per-feature prompt/policy
versions, including rollbacks. Its Run-backed AiEvaluation ledger deduplicates
feature-specific evidence/option fingerprints and fences publication against
the active generation, Workflow attempt and target-field audit revision. A
member edit returning the field to its earlier value still invalidates the
outstanding result. Discovery refreshes the live Product catalog, uncertain
unresolved Emails and pending Suggestions; it also revisits input-invalidated
or no-proposal field work when the relevant fingerprint changes. Settled
confident Emails and their member resolutions retain their domain authority.
Applied field targets, including inactive saved-form applications and rejected
member corrections with retained application receipts, are
reevaluated against current values when evidence or policy changes. Automatic
field assignments fill only empty effective values on eligible declared fields
at confidence >= 0.95, with supporting basis evidence and a winner at least
0.10 ahead of any runner-up. Populated values, saved field decisions (including
clears or any other audited update), rejected values, unserved trials and suppressed proposals never auto-apply.
Current input fingerprints fence every write; inherited values count as populated.
Automatic acceptance also requires complete dependency stamps matching the current
executable AI policy. Missing, incomplete, or stale provenance requires a new
canonical evaluation before application.
Create previews use the same confidence threshold and preserve populated draft
values. A field with declared resolution stays reviewable when its authoritative
draft resolver has not established an empty effective value.
The scheduled AI refresh discovery pass attempts existing pending proposals before
preparing another evaluation, even when inference inputs have not changed and no
client visits the record. Fresh eligible backlog applies through the same audited
transaction as new proposals; stale backlog is reevaluated through normal refresh.
Saved-record list and detail questions opt into canonical background evaluation
with `savedRecord`; the server prepares evidence from the saved entity rather
than trusting the client's displayed basis. Interactive form predictions remain
inactive and never schedule automatic writes, even when editing a saved record.
Admission deferrals keep interactive answers available; the next live question
retries canonical scheduling. Live scheduling waits for activation to match the
executable policy, just as recovery does.
Applied and rejected rows cannot re-enter pending application, and unchanged
settled inputs skip repeated inference. Below-threshold or ambiguous proposals
remain available for review. This field policy needs no measured-rule switch,
Sweep model pin or audit holdback; statement financial automation retains its
separate measured/import contracts. Validation and inherited/derived resolution
still apply; pruning and merging are separate actions. Feedback preserves
historical application receipts.

Mandatory field review is limited to concrete consequential exceptions declared
with `reviewRequired`: FinancialAccount issuer/network and sole purchaser establish
financial identity and attribution; Expense line kind changes accounting role; Cookbook and Device Product links
identify specific owned objects. Ordinary descriptive fields, including record
emoji and Vendor spending category/itemization, use the common empty-field
policy. Effective derived itemization values are populated and remain protected.
Vendor spending profiles default to `unspecified`, a populated value that remains
reviewable; removing its mandatory-review flag does not treat that sentinel as empty.
The mutable AssessmentState projection retains the latest evaluation's input and
policy alongside its application metadata whenever no replacement is published,
including when an exact wrong review or retained value suppression filters every
proposal and for legacy saved forms. No-proposal evaluations count as completed
work without increasing the Sweep's queued count. Reconciliation may advance a revision once
after application; settling the current basis makes later discovery skip evidence
preparation. Deleted subjects are skipped. Current write and input fences reject
edits during inference and later writes in the same
application transaction, including ABA edits, before capturing the settled
post-application fingerprint. These fingerprints avoid repeating unchanged
work. Rejected proposals without application receipts stay resolved. Eligible
unknown legacy provenance is evaluated once. Successful
ambiguity or missing evidence is terminal for that fingerprint; transient or
interrupted inference gets three attempts. Two independent refresh targets may
run globally, with dependent calls sequential. An execution claim defers immediately
when global admission is busy, preserving queued work and its attempt count for
the existing Workflow retry instead of occupying an origin connection in a lock
wait. Publication locks Runs before evaluation items and takes the activation
share lock only at its final commit fence, after business work and requester
wakeups. A deactivation or generation change during publication refuses or
rolls back the write. Product catalog preparation holds no transaction: each
pair publishes or registers demand in its own guarded transaction, and the
catalog completes afterward. Connection refresh likewise commits one prepared
connection or identity pair per guarded transaction. Interrupted catalogs may retain already committed
pairs; retries reuse their publication/work identities. Pair publication checks
a transient MVCC row-set fence in one statement instead of repeating snapshots:
preparation brackets the complete Product, identifier, source, photo/description,
import-claim, issuer-registry and variant-history dependencies, plus the whole
activation row version containing the producing manifest. The write transaction
rechecks them after taking the pair lock. New/deleted rows and edits invalidate
preparation. Any activation-row rewrite, including a code-only deployment with
identical policies, conservatively requires fresh preparation; issuer-registry
edits do too. No read-set fence is stored as durable provenance. Email Runs freeze at most 200
items and run only while Mail import is on for that mailbox. Reused Email
stages require current source checksum and feature provenance. The
[AI refresh runbook](runbooks/ai-refresh.md) owns activation, observation and
recovery. Independent model grading and member labels follow the
[decision-grading skill](../.agents/skills/decision-grading/SKILL.md).

An omitted or null mode has no schema. Zod owns optionality, transformations,
nullability, descriptions, refinements, and defaults. Put create-only defaults
only on create schemas, and make partial update schemas explicitly optional so
omitted values preserve existing data. Schema maps reference these exact objects.

A storage string uses the declared field's kind and nullability, the key as its
column name, and no database default. An object such as
`{ key: "importedAt", defaultOverride: "now" }` overrides only the differing
storage facts: `nullableOverride` and `defaultOverride` replace the field's
nullability and the storage default.
Stored-field order and create/update/output/audit rosters remain explicit:
presentation defaults never grant mutation capabilities or introduce columns.

The declaration's top-level `storage` block owns the rest of the entity's table,
and the generator emits canonical Drizzle `pgTable` definitions separately from
`relations()`: definitions live in `generated/entity-table-definitions.gen.ts`
and the FK-closed identity group; `generated/entity-tables.gen.ts` assembles
relations and reexports definitions. `server/db/schema.ts` exposes both under
the same names. `storage.columns` adds operational columns
no model field declares; `indexes`, `checks` (a named SQL check, or a
value-set check whose values default to the field's read enum), and
`relations` (the `with: {}` names; a string is a reference column) name
columns as `{columnKey}` in SQL. Derived without declaring: the shortcode
unique index, the identity FK to `Entity(id, shortcode)`, and a
`<Table>_<column>_idx` index on every reference column no full index leads
with (`unindexedReferences` opts one out with a reason). Constraint names are
part of the committed migration snapshot, so a declared name is never changed
casually.

The `model.fields` roster owns field kinds, read keys, labels, validation,
controls, and display membership. `EntityBasicInfo` reads `display.detail`;
`createEntityDisplayColumns` reads `display.list`. List suggestions target visible
columns, so a suggestible field must declare list membership to be reviewed
there. Financial accounts expose issuer, network, and primary cardholder on both
surfaces. A field's
`display.renderer.list` or `display.renderer.detail` selects a semantic
renderer while the declaration continues to own membership, labels, ordering,
and widths. The generator emits narrowed TypeScript renderer IDs and Swift
renderer enums. Each platform keeps an exhaustive registry that marks every
declared renderer and slot as implemented, generic, owned by its container, or
unsupported with a reason. Executable queries, runtime option providers,
heterogeneous trees (rows of another entity nested under a row), dialogs, and
workflows remain handwritten. A self-referencing hierarchy is declared once:
`model.hierarchy` (`parentField`, `maxDepth`) names a readable single
reference to the entity itself and the depth a well-formed tree reaches,
which bounds tree displays and the Group by levels; filter descendant
expansion is cycle-guarded but not depth-capped, since writes do not enforce
`maxDepth` ([Filters and search](#filters-and-search)). `presentation.list.tree` opts
a hierarchy into tree nesting and requires it; location, task, and project
declare a hierarchy without a tree. Nesting is a server scope, never client stitching: every list
read of a tree entity (`entity.listBase`, `entity_read.list`, HTTP) accepts
`nesting` — `{scope:"flat"}` (the default for every caller), `{scope:"roots"}`,
or `{scope:"children",parentId}` — applied after the same filters and sort. A
root is a row whose parent is null or does not itself match the filters (judged
over the whole filtered set, so a matching child of a filtered-out or deleted
parent stays reachable); `roots`/`children` rows carry `childCount`, their
directly nested children that match the filters, and `totalCount` counts the
requested scope. The shared list scaffold (`server/generic/list/repo/list.ts`) owns it, so a
scaffold-built tree repository needs no code. The web table pages the roots and
reads an expanded row's first children page through the same query; a status
row after its children shows that read loading, a failed read or deferred
group with Retry, and Load more while the server counts more children.
Expansion resets when filters or sort change. `tree.toggle` adds a
nested/flat switch (a row of the phone Filter sheet), persisted as
`nest=on|off` (absent is `tree.defaultNested`, default nested). Grouped
nested rows section by their roots. Cards and the timeline stay flat. A whole-tree view
(the category hierarchy chart) reads `useServerTree`: the roots, then each
counted parent's children, level by level. A structured
value that every client would otherwise re-word declares where the record
carries its text instead of a renderer: `display.labelPath` for a list cell,
`display.detailLabelPath` for a detail row (a server-composed sentence, lines
joined with `\n`, built in `server/entity-kernel/repo/detail-display-labels.ts` and carried
as a `labelField`), `display.itemsPath` for a list of worded rows that each
open their record (`displayItemsField`), and `display.readPath` plus `format`
or `valueOptions` for a nested value. Enabling a structured editor on a field
shown in details also requires one of these display projections. Allocation rows
keep their Purchase link and server-formatted allocated amount. Structured histories naming other entities
use `itemsPath` so each party remains navigable beside its server-worded dates;
do not flatten references into `detailLabelPath` text. Clients print what the record carries;
none restates the structure. A generic native list renderer also declares
`display.labelPath` for scalar fields, using the field's own key when it already
carries the value. A date or timestamp self-label retains native date
presentation and formatted spoken text; a composed label from another path is displayed as text.
A legacy field override and
a manifest renderer may not claim the same surface; the compiler or registry
test fails instead of choosing one silently. `control.renderer` follows the
same contract for form controls. `display.columnId` preserves an existing computed column identity when
it differs from the field key (for example an evidence count); active list
column IDs must be unique. An override must match a declared list field; an
unmatched override fails instead of silently hiding the column; the
`titleField` identity column belongs to the shared standard-column pipeline,
so an override claiming it fails the same way. Computed
identities and domain summaries outside the field model remain explicit columns
alongside the compiled collection. Composite cells suppress their supporting
fields in list metadata so IDs, names, and logos are not displayed twice.
Standard name and image columns are declared by `display.standard` on their
fields. The shared table renders them once, preserving its name editing, image,
and tree controls; scalar column compilation skips those fields. Flat generated
CRUD lists derive identity editing only when `presentation.titleField` is the
same readable, updateable, non-null text field. Trees, transformed or custom
data sources, and explicit editors opt out automatically. The identity column
uses the title field's declared width and otherwise keeps the canonical
`w-64`; contextual `nameClassName` remains the low-level escape hatch. There is
no second standard-column roster in the browser registry.

Compiled `display.detailOrder` places the title first, then follows model order.
`display.listOrderOverride` orders list columns independently (model order also
drives form fields); it must be a nonnegative integer differing from the default.
`display.columnIdOverride` keeps a stable column ID when the field key differs — ids are saved layouts, filter bindings, sort ids and
saved-view keys, so a rename is never free.

Task and Project assignees use the identifier field’s member-scoped LedgerParty
picker and `assigneeId` / `assigneeMode` inheritance contract.
Both references declare outgoing graph paths and incoming inverses for their
stored assignee foreign keys, alongside the member lifecycle policies.
Reads expose effective `assigneeId`, `assigneeName`, and `fieldResolutions.assigneeId`;
list filters and sorts use the same effective SQL as hydration. Explicit null
means None and reset clears the stored override. Project’s field label is
Default assignee; task’s is Assignee. The static My tasks saved view combines
open status with `assigneeId: @me`; a filter declared `currentMember` accepts `@me`,
which the entity kernel resolves to the actor's linked member (nothing matches
without one; [ADR 0018](adr/0018-current-member-filter-token.md)). Unassigned uses the assignee presence filter. Both reuse the generic saved-view and resolution-badge paths.

A saved view may also declare `view` (the list view it opens in, such as
`shelf`) and `pin: { surface: "home", order }`, which lists it in the home
"Your views" row on web and Apple; neither takes part in active-view matching.
Inventory's `ownerLedgerPartyId` reads the effective owner and carries
`fieldResolutions.ownerLedgerPartyId`, so its Use inherited, Confirm, and Set
to Household actions are the generic resolution actions (`resolution.confirm`
pins the inherited value; `resolution.labels` names a null value Household or
Unknown). Its filter matches the effective owner by running the ownership
resolver and narrowing by id before paging; the declaration's filter
`sentinels` (`@household`, `@unknown`) are tokens every client offers beside
the roster and sends unbranded. Values are ORed and match any entry. Product's
derived `owners` (display format `resolvedList`: a label, an optional record,
and whether it is only inherited) rolls up its live entries, resolved only for
the rows on the page, and its owner filter adds `ownerPresenceFilter` plus
Unlocated products whose single acquisition would hand the owner down. My stuff, Wardrobe (plus the
`apparel` category family), Bought for me, and the ownership work queues are
saved views over these filters.

Native saved views compile column filters to HTTP query parameters, expanding
nullable sentinels into presence filters and static range presets into their
declared patches. A saved range preset must have a declarative expansion;
generation refuses an unsupported expansion rather than dropping its scope.
Applying a native saved view replaces filters and sort in one refresh. Storage
fields declared as `enum:inheritance-mode` derive their values from the field's
Zod read/create/update schema; existing enum storage contracts stay unchanged.
Native manual reference selection applies the declaration's explicit-intent
patch before its selected value, so choosing a value after Use inherited
replaces the staged reset. Every filtered task presentation, including Next,
charts, board, and timeline, resolves `@me` before reading.

Three generic display rules follow from declarations rather than code. A
select option's `description` is shown as the tooltip of its pill wherever
the value renders. A `number` field whose provenance is `derived` from one
`{ entity, relation }` source links to that target's list, filtered by the
entity's relation section for the same relation, both in its list cell and as
the detail fact's filter action. A read that reports
`fieldResolutions[field].mode === "inherit"` for an empty stored value
displays the inherited value beside its `FieldResolutionBadge`, while the
field itself keeps reading the stored value for edits.

Every list column falls in one of three buckets. A generic column is a
schema-eligible scalar with `display.list` enabled, rendered by `createEntityDisplayColumns` with no
code. A declared column with a named renderer is rendered by the platform's
manifest registry (a badge, a link, or a relation label) and retains the
declared label and sort. A legacy override remains only as a migration seam for
specialist columns not yet manifest-owned. An explicit
`add()` outside the declaration is reserved for client-hydrated data, relation
projections, a second projection that hosts a filter control, and the
synthetic identity column. A field without a scalar read key needs a valid surface read path, a real nested
reference identity, or a classified renderer with a proven input projection.
The compiler traverses dotted keys, `[n]`, and `[]` through optional, nullable,
lazy, and compatible union schemas; opaque transforms do not invent properties.
It validates list labels on lists and detail labels/items on detail. Named
renderers are classified by the existing `native-coverage.ts` owner during
shared compilation. Whole-row renderers declare their minimum consumed inputs
beside that disposition. `unsupported` remains a disclosed native gap; compiler
schema checks do not prove executable web or native registration. `display.listHidden` owns a
declared column's hidden-by-default state; pages retain
`initialColumnVisibility` only for computed or relation columns outside the
field model. `display.valueOptions` is the label/tone roster for an
enum-like value a field renders without a select control (a derived status, or
the `kind`/`status` member of a JSON field); read it through
`fieldEnumOptions(entity, key)`. A range filter's presets are declared as
`options[].expand` patches of filter fields (`{ costMin: 500 }`) and the
generator emits the expander; a today-relative bound is a static `@today-Nd`
token (location's "Not counted in 30 days"), so only presets that cannot be
static (calendar windows such as this week or year to date, open-ended counts)
keep an `expandRef`. `display.preview` marks the facts of the hover preview card
(compiled to `detail.preview`, in model order); a computed figure the card
needs is a read-only projection field on the server output, never a web-side
map. An entity with no preview field falls back to its hero stats and first
detail section. Detail overrides may provide a dynamic
label when the value changes its meaning, such as ISBN versus UPC. Static labels
remain declared. `EntityBasicInfo.afterFields` anchors computed facts after a
declared detail field without inventing persisted fields or API contracts.
Unknown detail override keys and computed-fact anchors fail explicitly.
`EntityBasicInfo` takes a declared `fields` section's keys
(`entitySectionFields(entity, id)`) instead of a local field subset, so the
declaration owns each section's labels and membership.

`model.sort` owns the declared list-sort roster: `fields`, the ordered,
complete sortable-column list.
`defaultOverride` replaces `createdAt` (or the first sort field), and
`directionOverride` replaces the field-kind-based direction.
Every `fields` entry is a `model.fields` key, a `model.derived` key, or a
`related:<view>` count. A sort whose value is not its stored column (a
vendor's live purchase count, a product's expected-quantity variance, a
reference ordered by its effective record's name) is a `model.derived` key,
so no repository resolves a sort by hand. The generator
emits the roster as `generatedEntitySort` in
`packages/schemas/src/generated/entity-sort.gen.ts`, and `defineRepository`
derives the kernel's `EntitySortContract` from that map, so no repository
hand-lists its own sort roster. The compiler enforces
`default ∈ fields` and rejects a sort entry whose derived field cannot order
(below). The same roster narrows the `/api/v1` list route (`sort` refined to
`fields`).
The native `EntityDescriptor.sortFields` is emitted from that same roster;
generic table headers enable server sorting only for those column ids. Native
sort changes restart pagination and replay the active search with its current
filters, rather than sorting only the already loaded page.

`model.grouping` is the ordered Group by roster: `model.fields` or
`model.derived` keys, including one to-one related path (Inventory's
`category` is `product.category`). The generator compiles each key into a
choice (`generatedEntityListFields[entity].grouping`, and the native
`EntityDescriptor.grouping`) with its label, its "No ‹label›" section, the
filter that addresses the same value, and a reason when it cannot group: a
multi-valued field, a `via` path through a to-many hop, or a filter-only
predicate. Clients list such choices disabled with the reason; the kernel
rejects them as `LIST_GROUP_BY_FIELD_UNSUPPORTED` with the same reason over
HTTP and MCP. A related-record section's key is the record's public id and its
label the record's title, ordered by label; an enum section follows declared
option order. The no-value section is always last. `listScaffold.read` and
`listScaffold.raw` put
the group order ahead of the sort, and its summary query (key, label, count
over the whole filtered set, `meta.groups`) shares that order, so loaded rows
are a prefix of the sections and clients assign them by position. A list spec
with a custom `count` must pass `joins`, which the summary reuses. A saved
view's `groupBy` opens the list grouped; web keeps the choice in `?groupBy=`
and Apple in the list's view state. Timeline is already arranged by date, so
both clients disable Group by there; Apple's search results are ranked by
match, so it disables Group by with that reason while searching and restores
the choice afterwards. Sections use the neutral band (a domain colour stays
optional) with a sticky header and a quiet tabular count; collapsing sections
is not offered. A section header's "Filter to this" sets
the section's value (and turns an "Include sub-…" toggle off) as the field's
include filter, and exists only when the choice declares a filter. Its
"Hide" keeps the grouping and adds the section's value to the field's Exclude
key, so it exists only when that filter can exclude; a level section's Hide
turns "Include sub-…" on, so the ancestor goes with its descendants. Hiding
the "No ‹label›" section drops No value beside picked values, and otherwise
picks Any value. Both actions reveal on hover and stay keyboard reachable on
web; on Apple, tapping a header opens a menu with both.

A choice whose section key is a related record of an entity that declares
`model.hierarchy` can group at a level (`groupLevel`, 1 = top, absolute from
the root): each row groups under its ancestor at that level, a row whose value
sits above that level groups under itself, and no value stays last. The
choice's `levels` (at most three, fewer for a shallower hierarchy) bounds the
level; any other choice carries a `levelReason` derived from the declaration,
which clients show on the disabled Level choices and the kernel returns when
it rejects the level. `hierarchyAncestorSql` walks up the same hierarchy the
descendant filter walks down, so a level section counts its key's
descendants, and its summary's `subtree` flag tells "Filter to this" to keep
"Include sub-…" on: the filtered list is that one section. Level rides beside
`groupBy` in the URL (`?groupLevel=`), the list request, Apple's view state,
and a saved view's `groupLevel`; changing Group by clears it.

Declare object-valued outputs as `json`, and render relations and structured
values through explicit overrides. A logo object is not a text field. Fields
already owned by a dedicated section, such as Wish candidates, stay outside
the basic-information roster. Mobile title slots use the column accessor value,
so linked identity columns must return the readable name and retain the entity
shortcode separately for navigation.

Filter descriptors are typed metadata. Static choices stay in the declaration;
icon-bearing option lists, identifier brands, and compound preset expansion use
explicit `{ module, export }` references. The compiler rejects unsupported
kinds/properties and duplicate columns or derived URL keys. `audit: true`
expands the standard created/updated date filters. A `stored`, `anyOf` or
`derived` descriptor compiles its predicate in the list scaffold; any other descriptor's
SQL stays in the repository's filter builder
([Filters and search](#filters-and-search)).

`model.intents` owns the browser editor's field fragments: `fields` maps each
semantic intent (`capture`, `full`, `identity`, ...) to model field keys,
`create`/`update` list the ordered intent names each operation accepts (the
first is the default), and `editorFields` names editor-only pseudo fields an
intent may reference without a model field (a flattened identity). The
generator emits `generatedEntityEditIntents`; the editing registry reads
rosters and defaults from it and keeps only per-intent behaviour (defaults,
seeds, builders). `generatedEntityFieldSchemaMaps` exposes every entity's
create/update/read field maps by key for form resolvers.

A descriptor with `deriveSchema: true` also owns its filter field's Zod, which
the generator emits into `generated<Entity>FilterFields` next to the field
schemas; canonical modules spread that map and add only computed filters (a
canonical key that shadows a generated one fails the identity test). The key
is `field ?? columnId`. `text` derives an optional string (the model field's
read schema with `schemaFromRead`, or a named value schema with `schemaRef`,
such as expense's several OR-ed `expenseSearchTerms`), `boolean` an optional boolean,
`presence` the shared presence filter, `multiselect` `oneOrMany` of
the read schema (`schemaFromRead`), a named enum export (`schemaRef`), the
static option values, or a plain string, and `range` the shared min/max or
from/to fields, with the numeric/date kind inferred from the model field
(`range.kind` overrides; `range.int`/`range.nonnegative` tighten it). A
declaration module must not export `filterSchemas`.

Generated artifacts provide the exhaustive entity keys and traits, public
shortcode contracts (the inbound-only `P-`/`L-` label aliases live only in
`packages/shared/src/shortcode.ts`, never in the manifest), schema bindings,
inspector metadata (server and the `entity/platform` schema surfaces only), browser route roster, the typed list search
schema per entity (`entity/generated/entity-search.gen.ts`: manifest filter
keys, table keys and `create`, with `defaults` naming every key for
`stripSearchParams`), kernel and MCP action capabilities, relation-specific
command schemas, repository/relation-adapter assembly, and contract cases.
The server's generated shortcode table bindings also carry physical title
columns, derived through `presentation.titleField`, the field's `readKey`, and
its storage mapping. Computed titles remain null and use the shortcode
resolver's explicit label overrides: a stored column, or a relational SQL
expression over the unaliased table. Resolving identities and labels therefore
does not load the complete entity field model.
Two rosters follow from the declaration. The **list roster** is every routed
entity with a contract: its index — generated, or hand-written like Image's —
and every client (native browse, HTTP `entity.list`, MCP) read the
kernel's progressive list, whether or not the browser writes the entity
(Cookbook, Image and Run are read-only). Specialist `listColumns` never change
where rows come from. Its repository then implements `listRead`. Only a
generated index feeds inline relation tables. The **CRUD roster**
(`generatedBrowserCrudEntities`) is the list-roster entities with create and
update contracts; mutation results and the generic editor key on it. Bulk edit
uses the derived bulk roster across all mutable shortcode entities, including
update-only entities such as imported Cookbooks.

Complete client vocabularies use `entityListBaseFor`'s projected infinite read:
each page loads base rows and only the declared enrichment groups the consumer
needs. The cache key includes the groups and selected schema fields; each page
validates its narrower row schema before entering the cache. Category pickers drain every
taxonomy page with hierarchy relations, aliases and descriptions, without
loading gallery, quality or derived table fields. Picker thumbnails use the
separate compact display-image read.

The list and detail route modules for a routed entity are generated by default
(`routes/_authenticated/<basePath>.index.tsx`
and `.$shortcode.tsx`, with the generated header); a `null` slot keeps that
module hand-written, composing route-only keys onto
`entitySearch.<entity>.schema.shape`. Every entity's detail is the generic
page over the kernel `get`, which every kernel entity serves whether or not it
accepts writes (image, cookbook, and the read-only Run included); the generator
rejects `route.detail: null` except for `recipe` (its route still renders
`GenericEntityDetail`, hand-written only for URL search keys) and `usda-food`
(the external USDA catalog). Specialized screens stay as detail slots in
shared shells — a Run's import workflow, photo batch, AI usage and changes are
slots gated by `purpose`.

Inspector metadata projects declared actions, filter keys, MCP operations,
lifecycle/capability flags, reference targets, schema source-reference strings,
and port source references. It is safe for browser imports because it contains
data and type-only imports, never server bindings or executable schema modules.

The declaration is authoritative only for declared mechanical behavior. A spec
does not replace a repository's transactions, locking, SQL, or workflow rules.

## Dormant storage inventory

These fields and workflows were flagged for low usage, not approved for removal.
Recheck current readers and usage before retiring any storage; empty queues and
null values alone do not establish that a contract is unnecessary.

- **Historical Run machinery.** `ImportPreparedOrder` and `ImportPreparedLine`
  are active contracts. Audit legacy approval/control storage only after
  checking current readers.
- **Review queues.** `MerchantVendorRule`. Shared Assessment/Feedback history
  and current projections have active review readers. `MailboxCursor` is active in
  Gmail pagination/replay and must be preserved. Recheck against Product match
  recall, collision review, and [purchase correction work](https://github.com/nickysemenza/cubby/issues?q=is%3Aissue%20is%3Aopen%20label%3Aarea%3Afinance);
  an empty queue alone does not establish that its workflow is unnecessary.
- **Always-null columns.** `Plant.daysFrom*` and `Plant.breeding`,
  `Planting.outcome`, `Vendor.returnWindowDays`,
  `Run.historyCursorUrl`, `Task.sortOrder`,
  `Meal.sortOrder`, `Wish.acquiredAt`, `Device.productId`, `Cookbook.report`.
  Image `captureDeviceLabel`, `capturePlaceName`, and
  `capturedAtOffsetMinutes` fill once the library path sends them (Images &
  photos).

## Runtime interface

All generic entity work enters through `executeEntity(context, command)` in
`apps/web/src/server/entity-kernel`. It owns:

- public-id and Zod validation;
- capability checks and normalized pagination/sorting;
- baseline get/list/create/update/bulkUpdate/delete/merge/search commands;
- declared attach/detach relation families;
- in-transaction dirty-root capture, then post-commit object cleanup and
  best-effort queue wake-ups; paged background work refreshes projections,
  embeddings and derived invalidations, with periodic repair for lost wake-ups;
- one normalized delete result with public references and affected-edge data.

Repositories own database access, transactions, invariants, and the exact
mutation order. Workflow services own operations that are not entity CRUD, such
as expense splitting, reconciliation, cookbook import, and product enrichment.
Extensions delegate to those services instead of branching inside the kernel.
Delete-effect accounting keeps its repeatable-read snapshot. A background cache
write may replace a tuple after that snapshot; the owning delete boundary makes
bounded fresh-transaction retries on serialization failure. A caller-owned
transaction or a committed delete's consumer failure propagates without replay.
Snapshot-based financial booking and classification reviews use the same
recovery boundary, retaining the submitted review fingerprint across attempts.

Summary `entity.commands` writes request reference-only mutation projections,
without hydrating unreturned detail or coverage. Trusted operation receipts keep
that summary; a later full replay reads the existing record without repeating
the write. Normal write bodies expose one final-output reader through
`defineMutationWriter`; `asActor` preserves it and `defineRepository` derives
projected create/update readers. A declared writer without that capability is
refused when bindings load. Mandatory mutation snapshots and domain work run
before the final reader; requesting a reference skips only response hydration.
Explicit unchanged
writes capture a durable root even when no audit diff exists, so background
processing can retire pending advice for that write intent. The fallback checks
this update's transaction enrollments, including released savepoints, rather
than depending on optional audit-receipt collection; audited writes do not
receive a second fallback capture.
Publication fences lock the expected input revision without rewriting its row;
unchanged background checks must not invalidate a serializable save's snapshot.
Field advice fences use the target's point revision and shared input epochs.
An inherited target/basis or same-kind basis reference retains its own-kind
epoch for ancestor values and referenced labels;
ordinary scalar advice does not become stale when an unrelated row of the same
kind is accepted. Connection discovery keeps its broader corpus epochs.

Partial updates preserve omitted fields. Scalar patching rejects undeclared
keys, skips unchanged rows, and audits changes in the same transaction;
bulk mutations report every selected row, including unchanged rows. Alias
deduplication, tree invariants, relationship writes, import settlement,
quantity reconciliation, explicit receiving, and deletion/merge transactions
stay on registered domain owners. Specialized renderers keep inline edits,
quantity displays, relationship filters, and computed facts; an unknown
renderer override fails rather than silently dropping a field. Semantic editing
intents select fields once; context-sensitive defaults, access rules, command
transforms, and editor-specific blank handling stay explicit, and canonical
schemas validate the resulting payloads. Domain wayfinding owns labels and
entity membership; the application-view catalog derives ordinary destinations
from it and the entity registry, while authored specialty destinations keep
their order.

Source generation never changes stored data; physical changes need their own
preserving migration under
[domain rules](agents/domain-rules.md#production-changes). Generated operation
rosters and primitive field enumeration do not establish behavior: exercise
shared compiler/runtime behavior with representative contracts and keep real
database/browser coverage for domain exceptions.

## Workflows

The fluent builder is the public graph-authoring interface; a bound workflow
exposes the same executable definition the inspector shows. Argument adapters
supply context and input, and application decisions belong to named steps. A
single repository transaction, provider operation, or pure computation that
needs no graph sequencing is an ordinary registered function: it runs directly
with tracing and exposes its operation identity to inspection without a
one-step graph. Repositories exclusively own transactions; the workflow runtime
has no transaction adapters, transaction nodes, or after-commit queues.

The runtime distinguishes reads, commits, and required effects. Workflow-level
failure translation preserves cancellation and effect-failure evidence.
Required effects follow their commit, including when cancellation arrives after
the write. Ordinary recovery refuses new or ambiguously acknowledged writes and
is not retried recursively by the executor. Queue messages are wakeups, not
durable jobs; handlers gate on the row's own staleness marker (README
"Background tasks").

Mapped and bulk workflows preserve input order and bounded concurrency. Started
work settles before failure, cancellation, or early close is finalized; later
windows are not prefetched. Finalization receives every completed item even
when its progress tick was not consumed, and an empty operation keeps its
original completion metadata without inventing an item.

The agent stream is a direct async generator: it acquires and unconditionally
releases read-only tools, preserves event order, and forwards cancellation.
Cookbook preparation feeds the shared bounded bulk executor; there is no
generic preparation framework. Import settlement keeps committed recipe
receipts for final costing and indexing. Background payload graphs expose
revision checks, replacement dispatch, provider calls, and persistence; queue
draining caches each batch-kind lookup once.

## Transports

Generic detail, list, deferred filter-option, and write operations use one
authenticated operation dispatcher and generated entity-to-input/output maps.
Specialized shapes such as Image and USDA Food are ordinary operations in
`server/domains/<domain>/operations*`, so they share the operation module's authentication,
validation, errors, cancellation checkpoints, tracing, and console
observability.

Ordinary browser calls POST a SuperJSON operation envelope to
`/api/operations/<operation>`. Concurrent reads share a
`/api/operations/batch~<operation>,<operation>` request and stream their results
independently. URLs contain registered operation names, never input values;
the server rejects a path/body mismatch. The Worker routes these paths directly
to the shared dispatcher without loading the React server handler. Operation
and entity trace headers remain available; SSR invokes the dispatcher in-process.
Direct browser requests enforce the same native hosted-workspace version gate
as Start requests; an already-open outdated WebView cannot bypass it.
This transport retains query coalescing and independent settlement, which the
framework server-function transport does not supply across operations. That
capability comparison is not a measured production latency advantage.

All query requests share the concurrency limit, including singleton reads and
unanswered items retried after a broken batch stream. Only recognized transient
database failures receive bounded backoff; mutations are never replayed by this
transport. Terminal failures include the preceding failed attempts and their
diagnostics. Superseded browser endpoints are removed in place; open clients
reload after the cutover.

The dispatcher measures selected-handler loading in
`start.dispatch.load.<operation>` before the operation's execution span. Include
that load and Worker startup when attributing cold request latency. In deployed
Workers, application timers advance only after I/O: module initialization can
appear as zero-duration loading and be charged to the next I/O interval instead.
A long query span therefore does not prove slow database execution. Compare
matching platform profiles and origin execution evidence; label local startup
and request profiles separately from production evidence. Focused Problems
reads dispatch through their canonical source before loading entity readers or
unrelated diagnostic implementations.
See [Cloudflare's timer contract](https://developers.cloudflare.com/workers/runtime-apis/performance/).

The operation boundary chooses the read policy before invoking its handler.
`apps/web/src/server/db/read-policy.ts` owns that policy; ordinary interactive
operations currently use authoritative reads without a freshness RPC.
Specialized snapshot/external-service readers select their own sources.
Transport methods do not determine policy.

Operations that are not entity CRUD have one path: an operation contract in
`src/contracts/`, implemented once in the owning domain's operations module
(`src/server/domains/<domain>/operations.server.ts`, or `operations/*.server.ts`
when a domain has several)
with `implementOperationDomain(contract, handlers)`, calling repositories. The
browser client, HTTP API, and MCP are adapters over that implementation and
hold no business logic; there is no per-transport `*-browser.server.ts` module.
Removing an operation has no deployment shim: a tab loaded before that
deployment must reload before calling the removed function.

The MCP surface is declared once in `apps/web/src/contracts/mcp-tools.ts`: grouped
tools, each a group of actions called as `{ action, ...fields }`, where an
action is a contract member or an entity-kernel verb. `pnpm generate` binds
every action to its `implementOperationDomain` handler and refuses a tool that
mixes queries and mutations, so read-only tools stay auto-approvable. MCP
invokes `executeEntity` through the kernel verbs of the `entity` (writes) and
`entity_read` (reads) tools and publishes their machine-readable contract at
`entities://catalog`. MCP, jobs, repositories, entity modules, and kernel tests must
not import browser transport modules. Operation adapters and typed JSONL stream routes are the only transport
seams; business behavior remains in the operation modules.

## Browser cache policy

Contracts (`apps/web/src/contracts/*.contract.ts`) carry browser cache policy as
data: a query's `cache: { tags?, profile? }` and a mutation's
`invalidates: RippleKey[]`. Tags default to `[domain, member]`, so a member
declares them only when they differ (`tags: []` opts out of tagging).
`invalidates` names rows of the fan-out table in
`integrations/tanstack-query/cache-tags.ts`; an empty list is a deliberate no-op.
The vocabulary types live in `contracts/cache-policy.ts`, which contracts may
import; no contract holds React, query-client, or input-dependent code.

The Start operation stage of `pnpm generate` resolves that data into one
generated browser catalog, `integrations/tanstack-query/generated/catalog.gen.ts`,
with a domain object per contract (`product`, `recipe`, ...) that call sites
import. Policy that must read the call's input (the per-entity output schema and
cache profile of `entity.list`/`entity.detail`/`entity.timeline`, the payload-keyed
fan-out of `entity.mutate`) cannot be data; it lives in
`integrations/tanstack-query/operation-overrides.ts`, and the catalog spreads it
onto its member. There are no per-domain client wrapper modules.

## Progressive lists

Standard lists use three shared operations: `entity.listBase`,
`entity.listEnrichment`, and `entity.listSummary`. Declarations own the deferred
field groups and their dependencies; fields outside those groups are core.
Generated schemas validate group ownership against the canonical complete row,
reject dependency cycles, and supply browser and native metadata.

Base reads perform authoritative filtering, ordering, grouping, pagination, and
exact counts; expensive expressions that select or order rows still run before
base results return. Enrichment reads accept public IDs, resolve declared
dependencies, and return canonical patches for requested groups. Summaries apply
the complete filter population, including ID restrictions, independently of the
visible page. Complete readers call the same selectors and loaders and validate
the composed canonical result. Specialist workflows keep their own readers.

The browser list session and native enrichment model track field readiness
separately: a pending value is not zero, a missing image, or healthy quality.
Visible columns and structural/provider dependencies determine requested
groups. Superseded work is cancelled, responses from earlier generations are
discarded, and ready patches preserve row identity and order. A failed combined
enrichment read falls back to the same reader per group so independent fields
stay available; healthy batches select their page once. Failed groups can be
retried.

MCP `entity_read.list` at the default summary detail publishes only
`entitySummaryFields` (`contracts/mcp-projections.ts`), so it runs `listFields`:
one selected read with the groups owning those fields, and the
complete-population summary. Selected reads retain authoritative filtering,
sorting, pagination and counts in that one page read. Their caller validates
actual loaded fields before schema defaults can insert values; a declared-optional
list key may stay absent, as the complete list also omits it. Unknown fields
fail before even an empty read. `resultDetail: "compact"` reads one key set
per entity for both list and get, decided from declarations: non-media
list-read fields that both published read schemas require, minus fields
declared as arrays or records of objects (empty ones included) and `textarea`
long text. Declared-optional keys (display labels, detail-only enrichment) are
left out because either read may omit them. Nested objects keep only their
scalar leaves, so `dataQuality` reads as status and score; `fields` selects
anything compact drops. `resultDetail: "full"` and kinds without a
progressive reader run the complete list. Product list readers start the page's
USDA batch as soon as its barcodes load, so the external lookup overlaps the
remaining enrichment reads.

Fast and view-backed Problems cards derive selected fields from their required
presenter schemas, using the same ownership and transitive loader dependencies.
View-backed cards run through the canonical Problem executor; full list
hydration remains available to raw consumers rather than running for every card.
The inventory price-path card requires its embedded product's effective price explicitly.
Shared group loaders may declare their consumer fields: selected reads load
them only when one of those fields is requested; full and group reads retain
their complete dependency behavior. For example, requesting inventory product
and location identities does not resolve acquisition ownership, while any of
its ownership fields still loads the complete inherited evidence.
Tracker Problems select only the identities used to join canonical membership
pages to the shared attention result. Project membership reuses that request's
complete attention snapshot through the existing list preparation dependency;
Task and Expense membership retain their canonical filters. Grouped and focused
tracker cards preserve attention facts, page order, and exact totals without
loading unused list enrichment.
Focused raw Problems consumers and count/continuation
reads retain their existing contracts.

SQL-backed diagnostics carry the sample/count intent to their canonical
repository: count membership without loading presentation payloads, and limit
sample rows before hydration while retaining the exact population total.
Algorithmic detectors may require the complete input to establish membership;
truncating that input would change the result. Finding samples use the same
active/retired eligibility predicate as counts and complete reads, ordered by
creation time then ID. Only selected proposed fixes are parsed; a malformed
selected fix still fails visibly, while counts do not depend on its payload.

The shared list scaffold selects relation-loaded page IDs with a window count,
so a nonempty page evaluates its canonical filter once for both selection and
the exact total. The ordered SQL rows determine graph-loading order. An empty
first page has an exact total of zero; later empty pages run the canonical
count separately because their offset can hide matches. Count-only reads,
custom selectors/counts and group summaries
retain their existing paths. Tracing reports the combined page/count phase as
`entity.list.core.pageWithCount`, without invented separate timings.

Create/update responses are bounded receipts across browser, native and MCP,
including `entity.commands` batches. They return the stable shortcode, canonical
saved scalar values limited to explicitly submitted fields, `appliedFields`,
and bounded mutation warnings. Collection fields are acknowledged by name;
the response never reloads an existing collection, dependent records, quality
coverage or recipe coverage. Full/summary result-detail requests do not turn a
write into an expanded entity read. Clients fetch expanded detail separately.
The same generated receipt schema owns every entity; read endpoints retain
their entity-specific detail schemas.

Relational collection patches use repository collection adapters: the kernel
owns declared identity and patch preconditions, while adapters read only
submitted keys and apply audited member deltas. Stored collections are selected
from the owning row, including in mixed patches. Decoding an existing JSON
column still costs its stored size; that does not permit a relational detail
read or rewriting untouched child rows. Member lookups require matching indexes.

Required authoritative validation and audit records remain transactional.
`sideEffects.derivedRefresh.mode = "background"` describes the freshness policy;
it does not claim a particular Run or provider request has already completed.

Timing evidence comes from
`pnpm --dir apps/web exec tsx tooling/checks/read-performance.ts --origin <origin> --output <artifact.json>`
with `CUBBY_READ_AUTHORIZATION` or `CUBBY_READ_COOKIE` supplied privately in the
environment; the script's options own sample counts, entity selection,
concurrency, `--input` populations, `--mode complete`, `--first-invocation`, and
`--caldav`. Credentials and response bodies are never written to artifacts.
Resource GET pagination uses `page=1` while progressive structured input uses
`pageIndex=0`; keep compared populations equivalent. The harness does not infer
platform cold starts from elapsed time. SQL count and database acquisition,
query and client-queue active-wall times come from the existing `Server-Timing`
request collector (rounded to milliseconds). The aggregate report separates
base, enrichment and summary operations, with per-request medians and
observed/total request counts for each. Private raw output labels individual
samples by operation without recording resource paths.
Absent, malformed, duplicate and streamed-response metrics stay null: stream
headers can precede the remaining work. Worker CPU still requires matching
sampled trace evidence; wall times do not establish CPU time. A decoded-row
measurement does not prove browser paint time. The
target is warm usable lists below 500 ms (300 ms stretch), with full enrichment
compared separately. No historical SQL-plan baseline exists for regional or
Hyperdrive placement; placement stays unchanged unless isolated repeated
comparisons show gains without regressions or recurring cost.

`--mode operations --input <request.json>` measures the browser dispatch wire
using a plain `{ operation, input }` or `{ batch: [...] }` request. Only
registered queries are admitted; the harness serializes and decodes the existing
SuperJSON and operation contracts. Use a single request for one query, or an
explicit batch of 2–20 queries. Each sample is one transport attempt, without
browser retries or fallback. The schema-5 artifact separates HTTP, transport,
dispatch rejection, protocol and RPC failures, and reports successful per-operation settlement times
as results arrive, separately from complete-response timing. Both batch
settlement and the nested operation must succeed. Missing, duplicate,
out-of-range and unterminated result lines fail the sample. Partial successes
remain visible alongside the failed request count; failed requests never enter
successful complete-response latency statistics. The input is fingerprinted,
not published; its fingerprint identifies equal inputs rather than anonymizing
them. Database medians describe successful requests only; failed-attempt metrics
remain available in the private samples. Unsettled results include operations
unanswered because their request failed as well as missing stream lines.
Request IDs and operation error codes appear only in private raw
output; inputs, result bodies and diagnostic text are never written. An observed
failure, including the optional warm-up, produces an artifact and nonzero exit
status. This is a read-correctness signal, not a performance threshold gate.

Schema 5 adds `requestedReads` and `workloadContext`. Report reads expose only
schema-enumerated slots (retaining order and duplicates); list reads expose the
registered entity, projection, groups, declared field ownership and group-loader
dependencies. These are requested/declared contracts, **not observed loaded work**
or inferred SQL/report dependencies. Summary output fields, arbitrary sort/group
expressions, complete resource reads and unsupported operations remain null.
Progressive mode records the base/enrichment/summary requests actually sent
during measured samples, keyed to their operation metrics. Empty pages request
no enrichment; populated pages record only server-selected enrichment groups.
Repeated phase shapes across samples are coalesced; an operation batch retains
each query position and duplicate, independently of its sample count. Full list
metadata omits empty ownership groups. Dependency metadata lists only direct
declared edges of requested groups; core-only reads report none. Filter field
names now live inside each list shape and are admitted only from that entity's
generated filter schema, never arbitrary input keys. Values, IDs, search text,
paths and diagnostics are excluded from both public and private samples.

Optionally pass `--context <context.json>` with strict operator assertions:
`{"environment":"local","population":"synthetic","scale":1000,"cache":"warm","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`.
Environment admits local/ci/staging/production, population only synthetic, cache
warm/cold/mixed, scale an integer from 0 to one billion (population record count),
and revision a full lowercase 40-character Git SHA of the **measured deployment**.
Missing context fields are null. No free-text labels or extra keys are accepted.
These assertions do not prove scale, cache warmth or deployment provenance;
response versions remain independently observed. Invocation/warmup, concurrency,
pagination and input equality fingerprints retain their existing meanings.

## Filters and search

Product expected-quantity range filters share a catalog kit walk and grouped
Expense ledger before applying their bounds. They use the same signed unit
contributions, live-ancestor rules, weights, and depth cap as the scalar and
page-sized quantity reads; missing history still yields a known balance of zero.

A filter declaration compiles its Zod-field binding and canonical URL keys used
by shared route search-parameter assembly, inspector metadata, and generated
contract cases. Static and deferred controls still live in the explicit filter
catalog; compound presets retain explicit codecs and option loaders. A
descriptor declared `stored`, `anyOf` or `derived` compiles its predicate; the
compiler infers no database behavior from any other URL key.

Every value filter is any-of: `multiselect` and `idMulti` (a single-option
flag is a `boolean`), and a single value in a URL, saved view, or MCP call
reads as a one-element list (`oneOrMany`). A compiled filter over a nullable
field generates `<columnId>PresenceFilter`; clients offer it as Any value /
No value options ORed with the picked values, so there is no `all` option or
separate presence filter. Over a reference, a soft-deleted record counts as no
value, as it does for the group key, so a "No ‹field›" section filters to the
rows it counts. A hand-written value filter declares the same key as
`nullable: { field, label }`. Problem assemblies and UI adapters must agree
on the nullable presence field; its label is presentation copy, not part of
the filter's query semantics. A filter over several values per row (a
`text[]` column or a `via` path through a list) also generates
`<columnId>Match` (`any`/`all`), the Match all control, which appears nowhere
else. A rosterless multiselect takes typed values, with or without Any value
/ No value. `currentMember: true` marks a Ledger Party filter that accepts `@me` and offers Me
([ADR 0018](adr/0018-current-member-filter-token.md)). Any value and No value
lead a filter's value list above a divider; No value combines with picked
values, and picking Any value clears them, since it already includes them.
Chips join values with "or" (or "and" under Match all); an inactive chip reads
"any" and an active Any value chip "has a value", so the two never look alike.
There are no per-filter meta-options (`all`, `either`), boolean AND/OR/NOT
trees, cross-filter OR, or typed search syntax: any-of, Match all, and Exclude
cover household questions, and a rare cross-filter one is a second query or
the agent's. The Work queue and calendar pages read their own pipelines, not
the entity list.

Every declared filter is a list Filters-menu entry. One no list column hosts
(a relation scope such as expenses' `productId`) gets its field from the
descriptor — `label`, else the noun its placeholder names, and Yes/No for a
presence or boolean filter without options — and its value rides in the
table's filter state beside the column-hosted ones, through the same URL
codec and server builder. Only a client-filtered table keeps column-less ids
out of TanStack's state. A declared `label` also wins over a hosting column's
header; a related view's text search is generated as "<Target> search" so it
never shares a name with the relation's record picker. Every list loads a
deferred roster for each reference filter (`useEntityList`); a caller's
`optionsKey` list wins when supplied. A multiselect with nothing to pick
from takes typed, comma-separated values. A URL value list escapes a comma
inside a value (`joinFilterList` / `splitFilterList`), so a picked tag
`quick, easy` stays one value. Two declarations of one request field — a
list column's filter and an older deep-link key for it — compile to one
`aliasOf` the other: the codec decodes the alias into the column filter's
state and writes only the canonical key.
`singleValue.group` names scopes that share one value (Email's Purchase,
Vendor and Vendor account): picking one in the menu replaces the others.

Every compiled value filter (a `multiselect`/`idMulti` over a
stored column or a `model.derived` entry, plus the generic data-quality and
pending-suggestion filters) also generates `<columnId>Exclude`, "is not",
with the value key's schema; the filter record stays flat, so URLs, saved
views, MCP, and Apple's filter dictionary carry it unchanged. Its predicate is
the include predicate built for the excluded values, negated as
`NOT COALESCE((…), false)` (`excludedFilterRequests` in
`server/generic/list/repo/list.ts`): a row with no value stays
(`IS NULL OR NOT IN`; pair it with No value's opposite, Any value, to drop
empty rows), a to-many path matches when no related row has an excluded
value, and excluding a hierarchy node excludes its descendants through the
filter's own "Include sub-…" toggle. Include and exclude combine ("Clothing
except Outerwear"). A declared `predicate` offers Exclude only with
`negatable: true`, which asserts its SQL reads only the values it receives.
One that reads request data prepared from the include values (an effective
owner) would ignore excluded values, so it keeps
the key with the reason `Include only: <its reason>.`;
clients disable "is not" with that line and the list rejects the key as
`LIST_FILTER_EXCLUDE_UNSUPPORTED` with the same text. Web column state carries
excluded values with `FILTER_NOT_PREFIX` (`__not__:`) beside the included
ones, and each side shows its own chip ("Category is not Outerwear"); Any
value, No value, and Match all belong to the include side, the subtree toggle
to both.

A field, path, layout, or filter side the compiler cannot support stays in
its menu, disabled, with a one-line reason derived from the declaration, never
hand-written per entity: web shows it as a secondary line and Apple as a menu
subtitle, since a hover tooltip does not work on touch. HTTP and MCP reject the
same request with the same text, unmasked
([README tenets](../README.md#tenets)).

Every list filter predicate compiles from its declaration: `scaffold.where`
takes the filters and a read context, and no hand-written condition. A
filter that cannot be a stored column, a `via` path, or a row set is a
`model.derived` `predicate` whose `reason` lives in the declaration. A list's
static row scope and a project page's embedded scope are
[declared scopes](#declared-list-scopes) that compile into `where` too, so no
repository ANDs a condition beside it. Email's
`purchaseId`/`vendorId`/`vendorAccountId` declare `singleValue: { reason }`
(`linkState` is relative to one scope record): their schemas accept one value,
the web and native pickers choose one record, and the repository rejects more than one
across the three. Each is also a `model.derived` predicate over the one scope
record they resolve.

A text filter declares `anyOf`, the list fields it matches when any one does,
and `declaredFilterPredicates` ORs a case-insensitive substring match across
them. A member is a stored `text` or `text[]` field (matched by element, and
read as its effective value when it declares `resolution.inherit`, so project
search finds an inherited location) or a `model.derived` key: a `via` path to
a text field or a titled record (to-many as `EXISTS`, so wish search matches
any live candidate's name, manufacturer or model, and task search the
effective subject product's name) or a `type: "text"` value. A multi-field
search is that declared list, never a predicate. `anyOf` does not sort or
group, and a text filter never declares `stored`.

A `stored` descriptor names the standard predicate over one stored column:
`stored: true` reads the column named by `columnId`; `stored: { columns }`
names it when the descriptor id is virtual; `stored: { array: true }` marks a
multiselect over a `text[]` column as an overlap. Enum filters
OR their declared `nullable` presence in, a boolean over a nullable
non-boolean column reads as presence (`true` is NOT NULL), and ranges are
inclusive bounds: a range reads its `wire` keys (`from`/`to`, and `presence`
for its Any value / No value), and a timestamp column bounds by household
days. A range's No value ORs with its bounds, as it does with picked values
("recounted before `@today-30d`, or never"); Any value beside bounds is the
bounds alone. The compiler rejects every other shape. A predicate that joins, ORs
across filters, or resolves ids is a declared `model.derived` entry, not
hand-written SQL next to the spread.

A date range bound is a calendar day or a relative date token, `@today`,
`@today-Nd` or `@today+Nd` (`dateBound`, #2415). Like `@me`, URLs, saved
views, Problems, MCP and native filter state carry the token, and the entity
kernel resolves it to the household-local day (`resolveFilterTokens`) before
any repository runs, so a saved view moves with the day and repositories see
only dates. A date range's URL value is a preset key or its bounds,
`from..to` (`..@today-1d` is "before today"); saved views, Problems and the
native saved-view wire expand bounds onto the range's `from`/`to` keys, and
the web and Apple range editors offer each bound as a date or as days
relative to today, keeping the token on edit. A number range's URL value is
likewise a preset key or `min..max` bounds onto its `Min`/`Max` keys; the web
editor checks each typed bound against the declared `range` (`nonnegative`,
`int`), shows `describe.lower`/`upper` beside it, rejects a minimum above the
maximum, and the URL codec drops a bound the declaration rejects instead of
failing the list. A range over a hand-written request schema declares the
same `range` limits for clients; `filter-manifest.unit.test.tsx` fails when an
editor would accept a bound its request schema rejects.

`model.derived` declares a list field that is not a stored column, or the
value a stored field orders and groups by when its column is not that value
(`tags` by its first tag, a reference by its effective record's name). Its
filter, sort, and group share one expression
(`server/generic/list/repo/field-compiler.ts`); a stored field's filters stay
on its column (its effective value when it declares `resolution.inherit`), so
only a `type` or `via` entry may name one. Each key takes
one shape:

- `{ via: "relation.relation[.field]" }` walks declared `local-path`
  relations to a record (its stored title) or a field of the last one. The
  scaffold compiles a filter to `EXISTS` over the path and a sort or group to
  a correlated scalar subquery that starts at the outer row's reference, even
  when the repository already joins that table: knowing each FROM would be
  per-entity knowledge, so a measured cost earns a declared index rather than
  a join-aware compiler. Only
  a to-one path (every relation `one` and every step outgoing) can sort or
  group. The compiler rejects any other in `sort.fields` with the reason it
  derives (`Goes through a list of Purchases. Only paths that lead to a
  single record can sort.`); in `model.grouping` it stays a disabled Group by
  choice showing its reason. A list request sorting or grouping by it (or by
  a `predicate`) fails with that reason over HTTP and MCP.
- `{ via: "<rows>.<terminal>" }` starts at a `model.rows` row set (below) and
  takes one terminal: a column of the row (a JSON item key), or an entity the
  row references (`importTargets.run`), which filters by shortcode and gets
  the "Include sub-…" toggle when it declares `model.hierarchy`. A row set is
  to-many, so it filters but never sorts or groups (`Goes through a list of
  Import targets. …`), and its value filters generate Any value / No value,
  Match all, and Exclude.
- `{ type }` is a repository value: the repository passes its SQL as
  `listScaffold(entity, table, { derived })`, whose argument type is
  generated, so a declared key without SQL fails typecheck. A compound value
  (an array of SQL, inventory `amount` as unit then size) orders part by part
  and cannot filter, except a `dateInterval`: its SQL is `[start, end]`, a
  NULL end is open, a range filter (`from`/`to` wire) matches overlap and a
  one-date filter (`param` wire, planting `activeOn`) containment. It sorts
  by start, then end, and cannot group (a disabled choice with its reason). A state that is one row value is an `enum` value whose
  `options` are disjoint and whose CASE yields no value outside them
  (inventory `valuationStatus`, purchase `reconciliation`, product
  `quantityVarianceState`); a filter that means several states picks them
  together, as Missing valuation is `priceable` with `unpriceable`. A value
  may be `{ value, set }`: `set` selects `("id", "value")` for the whole list
  and its filters match `id IN (SELECT "id" FROM set WHERE …)`, so one
  set-based walk serves the filter while sort, group, and projection read the
  per-row `value`, which must agree with it row for row (product
  `ledgerExpectedQuantity` shares one kit walk). A filter's `value IN (…)`
  pushes into a set whose branches expose `value` from an indexed column, so
  purchase `effectivePurchaser` reads only the requested parties'
  candidates before confirming them. A `text` value that holds a record's
  shortcode backs a branded `idMulti` filter, as that one does.
- `{ predicate, reason }` is filter-only SQL the repository passes the same
  way; `reason` says why it is not one row value (an effective owner is
  resolved outside SQL). Predicates are the countable declared exception and
  only shrink: each is listed in
  `apps/web/generator/entities/predicate-baseline.json`, and the generator
  rejects an unlisted predicate and an entry whose predicate is gone.
  `negatable: true` offers Exclude (above). `predicate` names the descriptor kind
  it serves, and the SQL receives that kind's parsed value: a trimmed string
  (`text`), `{ values, presence }` (`multiselect`/`idMulti`, with the
  descriptor's declared `nullable`; `idMulti` adds `includeDescendants`), a
  boolean, a presence, or `{ from, to, presence, param }` (`range`; `param`
  is the one request parameter of a range whose presets name a state).

A predicate stays only when the filter value itself defines membership, so no
value or row set exists apart from the request, or when its replacement needs
a contract only that filter would use. Computing outside SQL does not qualify
on its own: prepared values and prepared row sets carry app-computed data.
Removing one adds an integration test that runs the old SQL beside the
compiled filter over one synthetic fixture and compares row ids, with any
intended behavior change in its expected diff, and deletes the old SQL in the
same PR. Six remain, each with its `reason`:

| Predicate                                         | Why it stays                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| product, inventory `effectiveOwner`               | Its values mix Ledger Party references with owner states (`@household`, `@unknown`), resolved in app code over every live entry (`inventory/repo/ownership.ts`). A row set would need a column that holds a reference or a state, used by these two filters alone; the predicate receives the resolved id set. |
| project `dateRange`                               | The project's own dates overlap, or a dated task through its effective project, or an expense through its allocation shares: a deliberate non-recursive approximation (`dashboardProjectDateCondition`). It could become `anyOf` over a `dateInterval` and two row-set paths.                                  |
| email `purchaseId`, `vendorId`, `vendorAccountId` | The filter value defines membership: each resolves one scope record (`singleValue`) whose evidence SQL decides which Emails belong and anchors `linkState`, and each is the filter a `derived`-provenance relation names.                                                                                      |

A stored `text` filter ORs several terms when its value is a list, and a text
descriptor's `schemaRef` names that value schema (expense's
`expenseSearchTerms`).

Every compiled sort part orders NULLS LAST in both directions, as stored
columns do, unless the part declares `{ sql, nulls: "high" }` (empties first
when descending: a vendor's latest purchase, a purchase's vendor name) or a
fixed `direction` (an Email's received time stays newest first within one
link state). A `related:<view>` roster entry orders by the view's first chip
(`relatedSortExpression`) for any entity. USDA food lists read the external
release rather than a table, a declared exception whose service orders by its
declared values.

A filter descriptor reads a derived field with `derived: true` (the entry
named by its `columnId`) or `derived: "<key>"` (another entry, so several
filters share one value or a column filters by an effective value). A value
entry filters by its type: `text` as a search term, any-of, or presence;
`number`/`date` as a range or presence; `dateInterval` as a range (overlap)
or one date (containment); `boolean` as a flag (UNKNOWN reads as
not met) or presence (true is a value). Any other value reads NULL as no
value. A predicate and a value both receive the caller's quality read context
(`where(filters, [], { readContext })`); a value that reads it is
`listReadValue(read => sql)` and renders the canonical scalar without one
(product kit accounting reads a Problem read's materialized on-hand units).
SQL that needs request data (inventory valuations, an Email list's scope) wraps a
`listPrepare(load)` handle, whose `load` receives the request's filters, with
`.value`/`.predicate`; fields share a prepare by sharing the handle.
`scaffold.context(db, request)` loads each needed prepare at most once, and
only when the request filters, sorts, groups, or projects on a field that
reads it; a caller that already holds a prepare's data passes it as
`context(db, request, [[handle, data]])` (project attention items). `where`/`orderBy`/`filterPredicates` stay synchronous and take that
context, `list` builds it unless `spec.context` passes one, and `hydrate`
receives it. The generated `generatedEntityListFields` map
(`@cubby/schemas/entity-list-fields`) carries each entity's derived shapes,
row sets, term expanders, inherited fields, hierarchy, subtree toggles, Group
by choices, and declared scopes.

A compiled id filter resolves its shortcodes inside the list query, through
`shortcodeIdsSql`, rather than in a lookup before it: an unknown or
soft-deleted code matches nothing (#2333).

An id filter (stored, `via`, or an `idMulti` predicate, by its `brandRef`) whose target declares `model.hierarchy` matches
the selected records and their live descendants through
`hierarchyDescendantsSql` (`server/generic/list/repo/hierarchy.ts`), the one
recursive-descendant generator repositories also call directly. The compiler
adds a boolean `includeSub<Plural>` toggle descriptor ("Include sub-…") for
each such filter; absent reads as on, and `false` limits the filter to the
selected records. It replaced the hand-written pairs: inventory's
`locationSubtreeFilter` is `locationIdFilter` with `includeSubLocations`, and
project's parent filter is the stored `parentProjectId` with
`includeSubProjects`. A predicate receives the toggle as `includeDescendants`
on its `idMulti` value: expense's allocated project and spending category. A
row-set terminal reference (an image's import run) gets the toggle like a
`via` path. An inherited reference (task project, a product
category's effective spending category) is a `via` path through its effective
edge and gets the toggle like any other.

### Background derived data

Searchable entities use persisted `SearchDocument` rows for lexical search and
embedding input. Source preparation constructs SQL only for requested entity
kinds; a typed empty union arm keeps the source columns stable, and recursive
location paths are included only for Location sources.
An ordinary write records a durable dirty root and known
old/new endpoints after all authoritative changes in its transaction. It does
not enumerate dependents, refresh projections, fingerprint a corpus, run AI
admission, or fetch expanded mutation detail. Capture work scales with the
rows explicitly changed. Inheritance-changing edits are the deliberate
exception: they validate their affected authoritative graph transactionally.
FinancialTransaction account/date/kind changes similarly retain immediate
settlement-conflict validation across the Purchases they fund. These scoped
invariant checks may scale with affected records; unrelated edits skip them.
Neither exception permits synchronous derived fanout. Immediate refusal evidence
is bounded.

The bound covers ordinary scalar edits and derived refresh, rather than every
existing mutation workflow. Collection patch resolution can still read the
current collection/detail, and financial allocation edits keep their existing
whole-set validation and audit behavior. Product creation with a catalog code
also retains its existing optional cover lookup. Those paths have no uniform
foreground bound; they need separate collection and provider-work changes.

Dependency traversal lives in `generic/derived-refresh/repo/dependencies.ts` as
indexed keyset routes. Projection-only dependents are leaves; only declared
transitive input routes continue traversal. A Product's purchase-line text does
not turn sibling Products or the vendor's other purchases into dirty inputs.
A best-effort post-commit queue wake-up processes small
provider-free projection and dependency pages; the existing `derived_refresh` Run/StepRun handles longer work and
recovery. Search projections, assessment retirement, recipe totals and
embeddings complete through durable pages. Statement observation and settlement
writers advance a small input clock; a separate cursor checks at most 100
pending statement suggestions per page. Apply always revalidates authoritative
statement evidence, so delayed retirement cannot authorize a stale action.
Connection retirement similarly scans at most 16 pending Assessments per page,
including guarded field suggestions, against the shared input revision. It
owns guarded connection evidence exclusively; generic field retirement must not
treat a missing generic live-input fingerprint as stale connection evidence. It
finishes an epoch before restarting for newer edits and fences status updates
against intervening input or review changes. Preparation runs outside publication
locks and retains only candidate/version projections, not stored basis snapshots.
The epoch also includes the household date; pending date-dependent Project-tool
evidence schedules a wake at the next household day boundary even without a write.
Both retirement scans and the ordinary refresh frontier advance before the
driver continues, so continuous edits cannot starve projection work.
The projection frontier completes before recipe or embedding providers are
consulted. Provider backoff therefore cannot block new queue-driven projection
waves. Pending recipe computation remains visible after the frontier completes.
Recipe computation reads current
inputs outside the publication transaction; totals and page acknowledgement
commit together. A failed phase retains its error and continues dependency
traversal, so one failed record cannot hide its parents or other affected rows.
The projection page invalidates only that Recipe's totals and Product's
conversion coverage. Containing kits and Expense price evidence follow the
declared dependency routes. Unrelated failed work never hides healthy totals
or valid semantic candidates; suggestion application checks its authoritative
field inputs directly.

Frontier dependency packets query at most eight adjacent routes, stop at the
first nonempty indexed page, and return at most 100 references. Empty routes
share one publication transaction and cursor acknowledgement. If preparation
fails after an empty prefix, that prefix checkpoints first; the failed route
retries alone with the normal failure budget. A short final route completes the
scope immediately. Assessment advances directly to dependencies (or completion
when no traversal is needed); stored legacy `recipe` cursors still resume.
Projection also skips a separate assessment step when a bounded candidate
query proves none exist. Any candidate retains normal retirement paging and
fingerprint checks; failure of the optional absence query leaves assessment
scheduled, where preparation failures keep their own phase attribution.
Recipe computation and embedding publication remain separate from frontier
packets.

Each page has a single-use lease and acknowledges its exact Work version and
owner token. Expensive preparation and provider calls happen outside the
transaction. Short output transactions validate the captured input revision,
then update frontier metadata. Authoritative saves advance input revisions and
append immutable roots, field deltas and known old/new endpoints to
`DerivedRefreshCaptureInbox` after business writes. They never read or update
worker-owned Work/Scope progress. A bounded background transaction folds a
locked inbox page into Work/Scope and deletes exactly those captures atomically;
rollback retains the captures. Folding does not advance input revisions again.
Pending captures count as unmaterialized inputs until that fold commits, so
search/discovery cannot mistake the interval before folding for freshness. Lock contention reschedules without spending the
failure budget. Failures are bounded per phase and actual input fingerprint,
survive transport retries and new Runs, and retain raw credential-scrubbed
diagnostics for explicit retry in existing Run/maintenance surfaces. A derived
failure does not undo a successful save.

Application hooks provide immediate coverage; no database capture triggers
are required. Periodic reconciliation pages through authoritative rows and
removals without trusting hooks or timestamps, and separately repairs missing
recipe totals, missing configured embeddings and unfinished vector artifacts even when input snapshots are
unchanged. Healthy-service targets are search catch-up and discovery queue
eligibility within 60 seconds. Input scanning shares one cursor transaction
across at most eight adjacent table pages, stopping at the first nonempty
page. Each populated page still processes at most 100 rows; cursor progress,
observations and captures commit atomically, and a failed scan rolls them back.
Provider completion depends on capacity. Recipe
reads expose pending totals after that Recipe's invalidation page until its
totals publish. Projection-code changes require the streaming "Repair index"
maintenance action.
The full repair pass runs hourly. Ordinary entity edits do not advance the
repair-wide snapshot clocks: own-row changes traverse their dependency pages.
Observations retain direct owner identities, including child owners. Context
edits refresh those owners. Entity endpoint changes or removals retain the changed
entity as the root and refresh old/current endpoints as projection leaves,
except endpoints declared as transitive dependencies, such as Product pricing.
Saved Purchase endpoints of an Expense have a narrower paged frontier: project
text on adjustment lines refreshes without traversing principal lines or their
Products, including after reassignment or physical source removal.
Reassigning a reference must not traverse unrelated members of its old/new Project
or Vendor. Only input rows without a recognizable owner use conservative
repair clocks that can revisit a broader corpus. This backstop scans full
authoritative row contents in bounded pages, including opaque imported data.

`EntityEmbedding` retains immutable physical artifacts and submission receipts.
An intent commits before an external upload. Selection requires the expected
payload in storage, a positive observation of that physical ID through ANN
search, current document/model inputs and a final publication fence. Submission
acceptance alone is not readiness. A changed text returning to an earlier value
gets a new physical ID; retired IDs are never reused. Delayed uploads and
deletes therefore cannot overwrite or remove a newer selection. Remote cleanup
is paged independently and retains tombstones after delete submission.
Selected artifacts receive a daily integrity check; retired physical IDs are
re-deleted weekly to catch late remote submissions. Initial deployment replaces
legacy artifacts through bounded pages, so semantic coverage remains incomplete
during that one-time re-embedding pass. These maintenance reads and deletions
are ongoing background costs, separate from save work.

Every semantic query validates both its seed and returned physical IDs against
selected artifacts, live identities, current projections and model configuration.
One fixed candidate budget bounds overfetch; insufficient valid results or
unfinished relevant work reports incomplete coverage. Approximate search does
not claim exhaustive neighbour retrieval. A missing configured artifact also
withholds completeness, including documents saved while providers were disabled.
Unconfirmed visibility is retried
without regenerating embeddings and cannot certify a completed negative scan.
Connection fingerprints use fixed-size input/projection/embedding revision
vectors; a newly selected vector invalidates earlier source discovery coverage.
Valid connection candidates publish even when semantic coverage is incomplete.
The evaluation retains a raw coverage diagnostic and its existing bounded retry
budget; it cannot record completed discovery until coverage is confirmed.
Exhausted unrelated refresh work withholds that completion rather than preventing
all positive discovery for the input class.
Ordinary writes never perform discovery or manage AI admission.
Pending field suggestions created before authoritative input fingerprints are
retired and evaluated again; they cannot be applied using their old basis.

### Row sets and same-row matching

`model.rows` names a to-many set of rows a `via` can start at. A row set is
not an entity: it has no shortcode, manifest entry, or relation section, and
its key may not repeat a relation or `model.derived` key. `path` walks
foreign-key edges (`compileTraversal`) to a child or shared table, and
`where` narrows it by column equalities on the row table (product
`barcodes` is `EntityExternalId` rows with `source = 'gtin'`; soft-deleted
rows never match). `json` reads a JSONB array of records on the row
(financial account `aliases`), whose item keys the generator checks against
the field's read schema. A path row set's table, `where` columns and
terminals are checked when its SQL renders (`rowSetSql` in
`field-compiler.ts`), since the generator cannot see the database schema.
`repository` declares the columns of a relation the repository passes as
`listScaffold(entity, table, { derived, rows })`, SQL selecting `"owner"`
(the list row's id) and each column, a `{ reference }` column holding the
referenced record's id; the argument type is generated, so a declared row
set without SQL fails typecheck. It compiles to an uncorrelated
`id IN (SELECT "owner" FROM relation WHERE …)` and renders only when a
filter reads it. A relation may come from a `listPrepare` (`prepare.rows`):
expense `allocationShares` bounds its computed shares by the request's
other row filters (`rowSetFilterKeys` names the keys to leave out) and
allocates only the dimensions a filter reads (expense analytics, which
allocate the shares themselves, drop the allocation filters their scope
expresses — any-of values ORed with their presence — and keep the group for
Match all and Exclude); project `attentionItems`
renders `VALUES` from the attention rules' items; gardenEntry
`journalPlantings` is SQL (live journal links, plus whole-area entries at a
planting's location inside its window). `relation` names a stored-path
relation to an entity (product `subjectTasks` over `tasks`, which joins on
the task's effective subject product), whose stored fields are the row's
columns: an enum field's filter offers its options, and a date or number
field's takes bounds on the shared row. A related view's range column
(product tasks by due date) leaves its presence key to the view ("has any
task"), so an undated task still counts. A row-set filter keeps a
presence key it was already published under (expense
`projectPresenceFilter`); others get the generated
`<columnId>PresenceFilter`.

Every include filter through one row set matches the same row: the
compiler builds one `EXISTS` for the group, so account `source` Plaid with
`externalAccountId` `ACME-0042` means one Plaid alias holding that id. To
match independently, declare a second row set over the same storage.
Exclude negates its own values, independent of the group: no row holds an
excluded value, and a record with no rows stays. Any value joins the shared
row like a picked value (the column is not NULL; a reference is live). No
value matches a row in the shared `EXISTS` whose column is NULL, or a record
with no rows at all when every condition in the group asks for No value, so
an account with no aliases matches `externalAccountId` No value but not
`source` Plaid with it. Match all gives each picked value its own `EXISTS`,
each carrying the group's other conditions.

A text filter over a row set may declare `terms: "<key>"`, an entry of
`listTermExpanders` (`server/generic/list/repo/terms.ts`) that turns the
input into the terms it ORs as contains-matches; product `upcFilter` names
`productCode`, every barcode encoding of the typed digits. Its key union is
generated from the declarations, so an undeclared or unused expander fails
typecheck. The compiler moves `terms` off the client descriptor.

### Declared list scopes

`presentation.list.scope` is a list's static row scope: stored fields pinned
to NULL, the shape ingredient's `resolve.scope` uses (ingredient
`["recipeId"]`: a recipe's own ingredient rows are never listed, searched, or
counted). `scaffold.where` ANDs it into every list, count, and Problems read,
so `getEntityCounts` reads it through the same `buildXWhere`. It shows no
chip, and no request lifts it, `filters.ids` included.

`presentation.list.scopes` declares related scopes: a request key whose value
is another entity's list filter record, matched through `via`, a path or a
row-set terminal that leads to that entity. A project page scopes its task
list through `project` (the effective project, so subtasks that inherit it
match) and its expense list through `allocationShares.project` (any share, so
a fee shared onto the project matches). `projectScope` therefore holds the
project list's own filter keys a project page sets (`status`, `kind`,
`location`, `search`, `dateFrom`/`dateTo`, `completionYear`, picked from
`projectFiltersSchema`): its `search` matches as the project list's does
(name, notes, effective locations), and native filter state flattens it one
level (`projectScopeKind`). The scope
compiles to `EXISTS` over the path to a record in the target scaffold's
`matchingIds`, the live records its `where` selects. The repository passes
that scaffold as
`listScaffold(entity, table, { scopes: { projectScope: () => projectScaffold } })`,
a thunk because the target's repository may import this one; the argument
type is generated, so a declared scope without its scaffold fails typecheck.
`scaffold.context` builds the target's context, and the row set a row-set
scope reads, only when the request sets the scope, so a list without one
never loads project prepares. A scope is not a filter descriptor: it has no
menu entry, chip, Exclude, any-of, sort, or group, and its key may not repeat
a filter's. Expense analytics keep it in their where beside the allocation
filters their own scope expresses, since it selects whole expenses as the
list does.

## Child storage

An entity's `children` declares its physical child tables using
`defineChildTable` (`entity-definitions/child-definition.ts`). Family modules
in `packages/schemas/src/child-tables` own the columns, branded TypeScript
types, SQL defaults, update callbacks, indexes, checks, foreign-key actions,
and Drizzle relations. Child storage does not acquire an entity identity,
shortcode, client manifest, or automatic indexes. SQL constraint expressions
use `{columnKey}` placeholders validated against that child's columns.

Child read consumers explicitly opt into the shared list workbench with their
existing scoped query, stable read handle, navigation and named workflow
commands. Physical storage does not opt them in. Suggestions uses immutable
Assessment handles, so republishing evidence replaces review identity;
StatementRow exposes an opaque read UUID while source/externalId remains its
mutation selector. Neither acquires a UUID route or generic CRUD. Run findings
and photo reviews keep their parent-scoped commands and specialized editors.
Photo review's selected-Product evidence read supplies canonical notes, tags,
category and structured external identifiers alongside purchase and image
evidence. Comparison panels share that read instead of loading Product detail
independently; category summaries are bounded to the selected Products.
RunApproval remains historical storage with Run invalidation; it has no active
producer, reader or answer UI.

A column's `generated` SQL uses the same placeholders and emits a stored
PostgreSQL generated column; it cannot also declare a default or update callback.
Retained mail stores text presence this way, preserving the nullable and
space-trimming rules as content changes. Email quality reads this scalar rather
than decompressing original bodies during list and Work queue filtering.

A filter over child or shared rows (import targets, settlement references,
barcodes) reads them through a `model.rows` row set
([row sets](#row-sets-and-same-row-matching)), not a declared predicate.

Mail, statement-import, and image-processing storage belongs to the explicit
module registry (`child-tables/modules.ts`) because those rows are not owned
by one entity. Both registries generate canonical definitions in
`entity-table-definitions.gen.ts` and relations in `entity-tables.gen.ts`,
exposed through `server/db/schema.ts`; the existing
`image-processing-schema.ts` import boundary remains a re-export.

Shared infrastructure remains handwritten only where
`child-tables/retained.ts` records an ownership reason. Generation checks the
schema's AST against that shrink-only baseline: removing an exception is
allowed, while a new handwritten `pgTable` requires declaration storage.
Moving existing storage into declarations must preserve the Drizzle catalog
and emit no migration.

## Data quality

Compact entity facts, including board cards, use the shared quality value and lazy field explanation; they never summarize the quality object as a field count.

Product price checks share catalog price evidence for filtering and a scoped
numeric projection for quality hydration. Applicability, missing-value checks,
and exception fingerprints read the same projection during hydration. Both
projections reuse the kit-pricing rules used by scalar prices and list totals;
zero remains a known price and an absent derived price remains null.
Composite reads can supply statement-local presence evidence through the same
quality-filter context used by the list scaffold and Product filters. The Work
queue registers one materialized price relation when a compiled predicate
requests it; standalone filters retain their closed predicates. Numeric
fingerprints keep the canonical scalar or joined value, so sharing presence
does not change exception identity.

A Product's `commodity` flag marks interchangeable goods with no single
listing. It removes the brand, Identifier and Amazon ASIN checks from the
Product's applicable set rather than recording an exception, and it is a
deliberate member decision, never inferred from a placeholder manufacturer.
Only applicability reads it; those checks' fingerprints are unchanged, so
clearing the flag reopens the gaps while existing exceptions keep their
evidence.

Purchase paperwork-mismatch predicates share one vendor-Expense aggregate for
the total, line count and unpriced count. The reconciliation module owns their
common live vendor-line scope and numeric sum. Bulk reads (list quality
filters and score sorts, Work queue branches) join one Purchase quality
relation that groups Expense and settlement-allocation inputs once per
statement instead of a correlated scalar per row and check; the reconciliation
verdict filters read it through the same context when a caller binds it.
Exception fingerprints retain the same scalar evidence and rounding, so the
optimized verdict does not reopen an accepted mismatch. Custom list row
selects apply the scaffold's quality join from the page clauses. A Work queue
statement shares each relation as one MATERIALIZED CTE; a record-scoped read
keeps the record-level predicates, since a whole-entity relation cannot be
narrowed to the one requested record.
Checks read a bound relation's column through `qualityReadColumn`
(`data-quality/repo/registry.ts`) and fall back to their record-level SQL.
`filter-read-parity.integration.test.ts` pins every bulk relation's checks,
statuses and read-aware verdicts to the record-level SQL.

An Email's completed-import check matches a live, completed Mail import Run
owned by the same member with the original in its source list. Bulk filtering,
score sorting, and bounded hydration join a shared, deduplicated Email quality
relation before evaluating the check, so ordinary join planning can spill rather
than rescanning a source set per Email when a hashed SubPlan exceeds memory.
The relation also carries the Email's linked state, evaluated once for the
checks that read it. The data-quality registry owns both the relation and the
predicate context; list reads and Work queue counts use the same binding. Plain lists and counts
join no quality relation unless quality filtering or score sorting needs it.
Single-record predicates retain JSON containment. Historical source JSON allows
extra fields, excludes missing keys and malformed source arrays, and distinguishes
an explicit JSON null from an absent key.

Bulk Email review checks resolve each member Feedback's Assessment lineage
before joining current-checksum predictions to their owner. Only valid member
labels count; the latest valid label wins, and a correct verdict without a
correction uses the Assessment judgment. Review metadata never supplies a second
observation identity.

A Vendor Account has no stored or editable name. Its title is always
`<Vendor> · <member>` from the current parent names (`vendorAccountLabelSql`
in `server/db/computed/`), shared by account reads, list search and sort,
reference lookups, Run labels, filter options and the entity graph, so a
parent rename never leaves a stale label.

Every Purchase expects a Vendor Account; a missing account is an identity gap
on the Purchase and appears in its Research queue until assigned. Missing
attribution stays nullable so incomplete records can be captured without
guessing a member. Account purchase previews follow that explicit link and
show the three newest live purchases and the full count, never all purchases
from the shared Vendor. Vendor Accounts have no quality score until they have
actionable checks of their own; absence of checks does not mean 100.

Every live Vendor expects a displayable logo, including vendors with no
purchases or accounts. Its missing-logo gap appears once in the Work queue as
shared Research work. An evidence-bound `unavailable` exception still closes
that gap. The logo coverage meter counts all live vendors. Order-evidence and
website checks retain their purchase-based applicability.

Run uses the shared quality score, filters, sorting, and explanation. Its
progressive list declares quality and media enrichment groups, so base identity
arrives first and web and native request scores through the shared loader. Its
checks assess recorded actor attribution, a consistent timeline, and terminal
target outcomes for completed Mail import and photo inventory runs (and
historical validation and enrichment runs). A skipped or unavailable target
needs a recorded reason. Running or paused work does not need finished targets. Execution status remains separate from
quality of the recorded facts. The generic Runs list on web and native
hydrates the same Run quality. Image jobs are their own unscored entity
(`imageJob`) and are not assessed. Scored and unscored web renderer
coverage is type-checked against the generated list shape. Browser captures are required by the specific
commit contract, so their absence is not a universal Run quality defect.
Immutable scored entities without soft deletion use the same evaluator with
no tombstone predicate.

`capabilities.dataQuality` on an entity definition
(`entityDataQualityMetadataSchema` in
`packages/schemas/src/entity-definitions/definition.ts`) declares
`checks[{id, facet, kind, weight, scoreCap?, label, satisfiedLabel, message, placement}]`, `exceptions` (true where
the entity may record `DataException` rows), `related` (other
scored entities whose gaps roll up into this one), and `listOrder`. `id` must
be globally unique across every entity's checks — it doubles as the `dataGap`
filter option value. `satisfiedLabel` describes a passed check positively;
`label` remains the gap/filter label. `placement` names one owning `{field}` or
`{section}` for contextual web results; null uses the unplaced-check fallback.
The compiler validates that field owners render in a detail fields section and
that section owners exist after deriving relation sections. Placement changes presentation only: weighted scoring, caps,
applicability, and exceptions retain the shared record-level calculation.

The Research queue ([terminology](guide/terminology.md#purchase-research)) is no table: it is the
`research-queue` saved views on Product, Purchase, Expense and Vendor, which filter
`dataGaps` to the checks research can close and sort by `dataQuality`
ascending. A `DataException` bound to the evidence fingerprint removes an item
until its inputs change.

The dedicated `/work-queue` page combines those predicates with interactive
Problems, Email attention, findings and account work. It derives a filterable
Waiting for column from current source/account authority, with Either for
shared research and unresolved for missing private ownership. Its filter is
any-of: Me (mine or Either), Either, a member (routed to them only), and No
value for Unresolved. This is a read projection, not a new entity or assignment ledger. MCP `activity.work_queue`
uses the connected member implicitly and filters eligibility before counts
and paging; the household UI's routing filters do not grant private access.

The shared population query materializes routed candidates within each SQL
statement, after source/kind/vendor narrowing and before eligibility/search. This keeps
search selectivity from turning bulk quality joins into repeated nested-loop
work; it is not a cache across requests. Only typed facts required by the
requested sorts or vendor filter are projected across the population. Other amount/date/vendor facts use
the same record-fact declarations after page selection. Full eligible counts
remain independent of the page; the correct filter and stable sort precede
LIMIT/OFFSET, and only selected rows receive the window position used for JSON
order. Quality and display-image hydration remain page-scoped.

Run attention candidates join their current member and source account once in
the candidate relation. They share the same authority expression with scalar
Run-finding lookups: the live member/login and current source owner must agree.
A missing or deleted source account remains unresolved; it never falls back to
the actor or becomes shared work. These unique-key joins preserve one candidate
per Run, and the candidate predicate still owns Run liveness and attention.

Finding eligibility requires stored status `open` and either no expiry or an
expiry strictly after the evaluation instant. Problems and Work queue reads
filter that eligibility without changing stored status or resolution history.
Explicit Apply checks expiry before changing business records, even if no
Problems read has run. Expired findings remain visible in Run history and can
still be explicitly dismissed; reports offer no Apply action for them. An
already-applied idempotent reconciliation remains governed by its existing
receipt contract, rather than becoming invalid when its old deadline passes.
The retained open-evidence unique key depends on stored status, not expiry.
A writer introducing finding deadlines must dismiss an expired holder of the
same evidence key inside its write transaction before inserting fresh evidence;
ordinary reads never perform that transition.

Independent entity-predicate, diagnostic-backed and statement-import account
branches share the existing bounded Problems scheduler with four concurrent
tasks. Entity branches precede diagnostics in declaration order, followed by
account work; Project attention remains one request-local promise shared by
entity predicates and diagnostics. Its complete subtree snapshot also supplies
Project date windows to tool-ownership diagnostics, avoiding a second tree,
Expense-allocation and Task-date read. The snapshot promise remains inside the
request, and attention's independent reads overlap its load. Standalone
ownership diagnostics retain the date-only loader. A failed branch rejects the
read rather than returning an incomplete queue.

Every source excludes Purchases dated after the current household day, and
Purchases with live Expense lines all marked `future`. Purchase has no stored
`future` flag; Expense does. Deleted lines do not count, mixed planned/incurred
lines remain eligible, and an undated Purchase without lines is unknown rather
than planned. The same exclusion applies to the record-detail queue.

Project attention reads Task dependency state through the same blocker resolver
as the actionable Task list, using five narrow graph queries. It retains project
UUIDs and excludes checklist rows from the result while keeping them in the
blocker graph; it does not hydrate Task quality, media, or presentation fields.

Research and Email rows carry structured `gaps` (`{check, message}`): the
record's live gaps among the checks its saved view's `dataGaps` declares
(`workQueueGapChecks`). Every other row carries none and keeps its `reason`
text; a gap row's `reason` is its messages as sentences. The `check` filter
narrows each gap view's `dataGaps` predicate to the requested checks inside
the branch, and branches that cannot carry those checks drop out, so counts
and pages agree. Rows also carry the record's own `amount` (a Purchase's
`SUM(Expense.cost)`, an Expense's cost, a transaction's signed amount),
`date` (purchase, expense, received household day, or posted/transaction
date) and `vendor`, declared once per entity and reused by findings that name
the record; they sort and filter server-side with nulls last. Queue-entry age
is not offered: a read-time projection cannot know when work appeared.
`workQueue.forRecord` (household web only, not MCP) pushes an exact record
filter into every branch, skips field-level suggestion groups and record-less
diagnostics, and keeps the list's routing; the generic detail page and
inspector render those rows as a compact Work queue strip and nothing when
there are none.

The browser reuses shared infinite loading, column controls, checkbox selection,
Copy codes and responsive source-record inspection. Queue keys identify work
reasons; source shortcodes identify records and are deduplicated when copied.
Rows without source codes are not selectable. Filters clear selection, scrolling
preserves it, and refetched rows reconcile it with the loaded result set.
Select-all-matching uses the shared bounded pager. Projected fields sort before
paging with stable name/key ties; the enriched Reason column stays unsortable
and shows one chip per failed check (label from the check declaration, message
as tooltip and accessible text), filterable by check.
Filters and sorting are URL state; browser pagination keys are removed and
unsupported sort fields fall back to the default. Column controls are session
state. MCP retains its paged read contract. Run rows open passive Problems until
Run detail reads stop recovering execution.

The compiler (`apps/web/generator/entities/data-quality.ts`) synthesizes two
model fields (`dataQuality`, `dataGaps`) with the `data-quality` list
renderer, the `dataStatus`/`dataGap` filter descriptors, and a `dataQuality`
sort entry — the sort shares the column id, so the "Data quality" column
header sorts by score. **Declaration wins**: hand-spelling `dataQuality`,
`dataGaps`, or a `dataQuality` sort field anywhere else in the manifest is a
compile error — the block is the single source, the same way `filters.audit`
owns `createdAt`/`updatedAt`. A cross-entity pass enforces global check-id
uniqueness and turns each `related` entity's own check ids into `dataGap`
filter options on the rolling-up entity. The generated leaf
(`packages/schemas/src/generated/data-quality-checks.gen.ts`) exports
`dataCheck`, `dataChecksByEntity`, the per-check facet/kind/weight/label/
message maps, `dataCheckPresentation` (satisfied labels and ownership), `dataQualityFacets`, `relatedDataQualityEntities`,
`dataQualityExceptionEntities`, and `scoredEntities`; `data-quality.ts`
composes the public schema from that leaf.

Every declared check id needs exactly one binding in the web registry
(`apps/web/src/server/generic/data-quality/repo/checks/<entity>.ts`), typechecked two
ways: `entries.ts`'s `satisfies` against the generated per-entity check
union, and the registry unit test. A `CheckBinding<T>` supplies
`expected?(t)` (omitted = always expected), `missing(t)`, and
`fingerprint?(t)` — required exactly when the entity has exceptions, and the
inputs are whatever that check actually reads, never `updatedAt` (see
`docs/agents/domain-rules.md`). `t` is the entity's own table or an
`alias()` of it, so a related roll-up evaluates the same binding the related
entity's own list uses.

`sql.ts` builds every predicate as one parenthesized group so callers can
safely embed it under `NOT` or beside `OR` — a bare conjunction once emptied
a production worklist; the unit test asserts the shape.
`expected`/`missing`/`fingerprint` combine into a live-gap condition (expected,
missing, not covered by an active exception) and the score:
`100 × satisfied expected weight / expected weight`, limited by the lowest
`scoreCap` of an applicable unresolved check. A cap also applies to an
unscored integrity diagnostic: supporting evidence cannot turn a known defect
into perfect quality. Any unresolved check also caps at 99, so a rounded
display cannot show 100 while a gap remains. Caps belong in the declaration, alongside importance
weights; domain applicability and validity stay in the existing typed SQL
bindings. No applicable weighted evidence and no active cap produces a nullable
score and **Not assessed**, never an automatic 100. SQL sorting puts unassessed
records last in either direction and uses the same arithmetic as hydration.

Active exceptions remain accepted evidence for score arithmetic, but an otherwise
complete record is **Complete with exceptions**, visibly distinct from fully
satisfied evidence. Stale exceptions reopen their gaps. Every weighted missing
check must be closable through supported data entry or an allowed exception;
optional planning fields and operational inactivity are not universal
completeness requirements. Actual zero or negative costs remain valid.

Product core identity checks apply to every catalog record, including products
without stock or expenses. Name and known price carry weight 3, manufacturer and
identifier evidence weight 2, and category weight 3 with an unresolved cap of 69.
One nonblank manufacturer model or live nonblank external identifier satisfies
identifier evidence for every Product, regardless of category. Missing both
produces one Identifier gap, rather than research work to collect every possible
identifier. Any external-ID source and kind can qualify; blank values and deleted
identifier records cannot. The check retains `product_external_id` as its key so
existing accepted exceptions keep their evidence basis. Retired model exception
notes are preserved by a one-off data update; model-only exceptions remain stale because
they do not establish the absence of an external identifier. A known explicit or derived
price earns credit, including zero; an unknown price is required only for stocked
products outside miscellaneous buckets. Catalog inactivity remains an unscored
diagnostic, so recorded identity can earn points without purchase history.

Core identity, classification, usable evidence, and financial consistency matter
more than optional imagery and descriptions. Score explanations name deductions
and applicable caps. Related gaps remain separate from the owner's score and
must not propagate through recursive relationship chains. The score is unindexed — a correlated `EXISTS`
per check per row — which is fine at household scale. `related` roll-ups add
an `EXISTS` against an aliased related table using that entity's own
bindings; `generic/list/repo/list.ts` binds the resulting filters and sort for every
scored entity's list in one place.

Durable "not available" exceptions (`data_exception.set`/
`data_exception.clear`) live in the `DataException` table, keyed by an
`Entity(id, kind)` FK, for every entity whose declaration sets `exceptions`.
Enabling it requires fingerprint inputs for every check and an allowed-reason
list per check (`EXCEPTION_REASONS` in `generic/data-quality/repo/exception-reasons.ts`, exposed on each
explained check as `exceptionReasons`). An
exception goes with its entity when the entity is removed or merged away.

Recording a finding requires a nonblank explanation of what was checked and
what was found; include source references where available. Explanation notes render
Markdown source links in web and Apple controls. Those controls
never substitute the reason label for that explanation. Existing reason choices,
evidence fingerprints, audit history and scoring remain shared across entities.
Clearing removes the finding and reopens its gap; it does not block a later
source-backed finding. Changes to the fingerprint evidence make a finding stale.

Reference read surfaces display effective resolution, while editors retain the
stored assignment baseline. Quality cells retain their semantic null state in
phone cards (`mobile.showWhenEmpty`), so Not assessed is visible even though
there is no numeric score. Named reference pills use the target's projected
name; provenance may name a different source record and must not supply a
mismatched label. Allocated references share the `<stem>Allocations` projection
with `<stem>Id`, `<stem>Name`, `amount`, and `incomplete` fields. The generic
reference reader renders distinct targets and unresolved-share indicators in
lists, embedded tables, and details. Detail allocations retain their amounts.
Do not create another entity-specific category column or allocation renderer.

## Relations, deletion, and merge

Every logical relation declares its target, cardinality, primary named source,
provenance path, and inverse path. A relationship may add more named sources;
for example, `Purchase.products` combines detachable `explicit` evidence from
`purchaseProduct` links with non-detachable `expense` evidence from every live
product-linked Expense, including exits, adjustments, unknown quantities, and
planned lines. Counts, filters, inverse navigation, and graph traversal use the
same deduplicated union. Movement roles and planned status are backend evidence;
an unconfirmed explicit-only link is Linked and does not establish acquisition or
ownership. Existing links remain unconfirmed. Explicit acquisition confirmation
(`EntityLink.acquisitionConfirmed`, allowed only on `purchaseProduct`) establishes
Acquired with unknown item cost and quantity; it creates no Expense or inventory.
The purchase date locates its timeline marker as order context, never delivery;
confirmation supplies no ledger date or ownership interval. Exact Expense binding
remains separate, and itemized acquiring Expenses remain authoritative. The
unpurchased quality check accepts confirmed live purchase links or real acquiring
Expenses, excluding plans. Acquisition dates and pricing retain their narrower
acquisition rules.
Mutable sources additionally name a typed item schema, adapter, and
transport exposure. The compiler rejects duplicate relation/source keys,
unresolvable mutation sources, invalid inverses, and stale generated bindings.
Read adapters may expose paged rich rows through `entityGraph.relation` and
the kernel's `listRelation` action. Purchase/Product reads select and count
distinct live pairs before enriching the selected page, preserve explicit-link
detachability alongside movement evidence, and use stable date/name plus ID
ordering. Undated purchases sort last. Filtered target IDs constrain both the
page and its count; a client must not fetch an entire relation to decorate one
visible page.

Lifecycle is deliberately separate from logical relationships. Physical edges
carry stable domain meaning, while each delete or merge operation declares its
own disposition for every incoming edge. The integrity catalog records whether
the executable owner is the generic kernel or a specialized workflow. There is
no logical `deletionPolicy` and no inferred database cascade.

Deletion is one command. Soft versus hard deletion is a capability, and the
result identifies the deleted public references plus a non-null changed-row
count for every affected-edge disposition. There is no restore. Delete and
merge confirmations show an advisory impact list (`entityGraph.connections`
with an `operation`): each incoming edge group with its count and declared
disposition. The mutation re-checks in its own transaction and its structured
refusal stays authoritative.

Merge is keeper-wins. Declared edges are repointed, only explicitly mergeable
fields combine, and uniqueness or workflow collisions reject the operation.
Entity-specific merge code remains only for irreducible transaction and
collision rules. Accepted research proof follows its canonical Product or
Purchase subject independently of the source task. A merge folds only identical
proof identities and preserves independent retained evidence and actual support.
Colliding Run targets fold only within the same Run, entity kind, and frozen
work key; evidence and proof references move before the absorbed task is removed.
Purchase and Run soft deletion retain proof against their tombstones. Product
proof remains retaining history and blocks deletion; an Image hard deletion
removes its proof before its worklist target and detaches retained original
evidence to the owning Run. These history references do not claim ownership of
an Image.

## Relationship discovery and suggestions

Web and the Apple apps render the graph, paths, inspector, and connection review
through one React workspace. Swift owns its authenticated host and native record
navigation; ranking and eligibility remain server-owned. CubbyKit retains the
ordinary `/api/v1` mappings for native API consumers. The cross-client wire
example `packages/schemas/fixtures/relationship-discovery.json` feeds both Zod
and Swift mapping tests. Inline previews and the full Relationships section
share one query result; the workspace's graph and list share selection and
loaded data, and graph state is local to the active workspace.

`entity.explore` takes an entity reference and a depth of one to four and reads
the manifest-backed graph breadth-first, returning nodes, directed edges,
branches, explanatory paths, and completion state. A hop is a displayed
relationship; a derived relationship keeps its declared provenance. Each branch
contributes its first 12 records and keeps `nextOffset` for explicit paging
through `entity.graph`, so deeper levels never silently exhaust a large branch.
Reads batch up to 25 roots under aggregate ceilings of 500 records, 1,000
edges, 32 reads, and ten seconds. Completion distinguishes exhaustion from
depth, pagination, and budget limits; returned paths explain the explored
records and do not claim an unsearched branch has no shorter connection.
`entity.graphPaths` remains the destination-path search. Cycles are valid, and
all traversal applies the live-record filters, including on intermediate tables.

The operation handlers hydrate each graph's optional `preview` from the existing
selected-field list readers, once per entity kind. The shared preview roster
selects facts and status; those canonical reads own money, quantities and
progress. Graph rendering never computes a separate unit price or spend total.
The graph's structural metadata stays available to native clients. Detail-page
context uses populated curated connected views, rather than arbitrary graph
reachability. Product purchase-project context follows `expenses → project`,
so a sibling product on the same order cannot lend this product its project.
Each surfaced target retains its witnessed, linked path; multiple projects are
reported together rather than choosing one implied purpose.

`recommendations.forEntity` returns a source reference, a source-context
`basisKey`, and typed groups; discovery works when recommendations or a
similarity index are unavailable.

- **Expense projects:** candidates overlap the expense date, exclude the
  current project, and rank by same-trade principal expenses, then exact-product
  principal expenses, then the narrower date window, name, and identifier. The
  reviewed expense is excluded from history and derived dates before ancestor
  windows are folded; explicit date overrides win. At most three candidates and
  three supporting expenses per candidate are returned.
- **Inventory placement:** stock in Unknown earns a suggestion only when the
  exact product has one unambiguous other live stock destination.
- **Product relatedness:** semantic candidates and shared-tag evidence remain
  discovery, with their similarity readiness state.

Graph proximity alone never enables a write. A Sweep publishes expense project
and inventory placement proposals into the shared Suggestion queue. Passive reads
never discover candidates. Their family handler uses the expense update or
inventory move operation after explicit acceptance, rechecks the stored basis,
keeps failures reviewable and refreshes affected views on success. When a move
coalesces stock into an existing row, both clients follow the surviving row and
replace the deleted source in navigation.

Work queue reads count stored active pending connection state without rebuilding
evidence. Its list and view counts share one filtered population statement;
background retirement may leave display state briefly stale. Opening connection
evidence and applying a suggestion retain their current-evidence checks, with
application fenced inside its domain transaction. Ordinary entity writes capture
input revisions; no queue read starts discovery, model work or a refresh scan.

Interactive connection freshness reads project only the declared fingerprint fields of
each entity and the stored candidate/version, never full entity rows or stored
basis snapshots. Recommendation reads compare the recomputed fingerprint;
field connections compare the current basis with retained JSONB inside
PostgreSQL. Preparation is bounded by candidate batches, independently of source
roster size or queue pagination. Shared Project recommendation inputs are read
once for the invocation's roster; only the current batch's expanded contexts
are retained. These read projections preserve immutable
evidence and the family's transaction-time acceptance checks.

### Product relationship route

`product.relationshipRoute`, keyed by the Product's public shortcode, owns
Product relationship previews; generic inspectors and route renderers must not
recreate its semantics with client-side fan-out. Product is the selected
station. Inventory/Location, Purchase/Expense/Vendor, Project, and Task are
conditional branches from Product, not a chain: a visual route continues
through a branch only when the record supplies evidence for every edge, so a
Location never implies it caused a Purchase, nor a Purchase that it belongs to
a Project.

The result separates `direct` and `derived` branches (direct first), returns
exact branch counts with at most three deterministic previews, uses public
shortcodes for every linked station, and exposes source/provenance labels,
never SQL or renderer concerns. Empty branches explain what is absent without
inventing a station. Deeper pagination stays lazy; generic layout owns only
disclosure, links, loading/error geometry, and accessibility.

| Station                | Meaning and source                                             | Required distinction                                                                        |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Stock                  | Product → InventoryEntry → holding Location                    | A holding Location is not an identity-only Location.                                        |
| Also a location        | Location whose identity is this Product                        | Keep separate from “Stock”.                                                                 |
| Expenses               | Acquisition or disposition lines keyed by `productId`          | Explain kit-owned expenses and explicit manual prices where applicable.                     |
| Purchases              | Explicit `purchaseProduct` links or inferred itemized Expenses | Label `Direct link`, `Via expense`, or both; exit/future Expense rows are not acquisitions. |
| Vendors                | Derived attributed Product Expense → Purchase → Vendor spend   | An explicit `purchaseProduct` link alone is not vendor spend.                               |
| Used on projects       | Explicit reusable-tool usage                                   | Keep separate from acquisition attribution.                                                 |
| Purchased for projects | Derived acquisition-spend project attribution                  | A Project may appear in both project branches.                                              |
| Tasks                  | Nullable `Task.subjectProductId` links for non-food Products   | Preserve the existing task creation path and truthful empty state.                          |

The station labels above are required; do not collapse paired meanings into a
decorative graph. A recategorized Product keeps historical project-use evidence
visible and linkable, while category-gated mutations stay read-only. Soft-deleted
intermediates and targets never appear in counts or previews; real unassigned
project attribution is shown. Every linked target opens its canonical
`/<plural>/$shortcode` route. `ProductPurchaseOut` carries `vendorName`, not
`vendorId`: Purchase stations open Purchases, and the derived Vendor branch owns
Vendor links from its own evidence. Specialized Product sections remain the
source of their mutation behavior. The
[local journey coverage map](agents/core-journey-e2e.md) tracks the
relationship browser check.

## Identity, attachments, and the physical graph

Every shortcode entity has one durable `Entity` row (ADR 0006): payloads bind
to it with a composite `(id, shortcode)` FK, and database triggers write it on
insert and mirror soft and hard deletes. `finalizeMerge` records one-hop,
path-compressed `mergedIntoId` redirects. A read through a merged-away code
returns the survivor with `redirectedFrom`, and detail reads list
`previousShortcodes`; a write through one refuses with the survivor's code, and
a deleted code refuses with the deletion date. Codes are never reused, even a
hard-deleted payload's.

Direct files are `EntityAttachment` rows: gallery photos and purchase documents
(`attachment`), a cookbook `cover`, a vendor `logo`. `imageJoinBindings` and
`imageCascadeChild` all target that one table; `purpose` is Product-only and
`documentKind` Purchase-only. Detach soft-deletes, a removed subject's
attachments are detached and reaped, and an upload's idempotency key belongs to
the attachment rather than the file.

Attachment inputs labeled `application/octet-stream` are unknown formats, not
an additional accepted file format. The shared attachment service inspects their
bytes using the same supported image/PDF signature checks (and image dimensions)
as specifically typed inputs, then stores the resolved MIME type and matching
filename extension. Base64, URL, and staged-upload inputs share this validation;
unknown bytes and unreadable images fail before final storage. A filename never
establishes the format, and a specific MIME label must still agree with the bytes.

Before linking or importing an Email, the `mail-attachment-purpose` Decision
classifies each retained file using the Email context and attachment metadata.
Only a high-confidence `purchase_document` result attaches automatically;
`shipping_label`, `uncertain`, low confidence, or evidence exceeding the Decision
context bound leaves the file with the original Email. Filenames and subjects
are hints, not classification rules. The Email body can still establish a
shipping charge, and original attachments stay retained and readable. Inference
runs before the linking transaction; publication rechecks the Email checksum and
attachment metadata/checksums. Model failures propagate without a heuristic
fallback. Explicit file attachment remains available.

The physical graph is composed at read time from `ENTITY_EDGES` and
`ENTITY_EDGE_OWNERS` (`generic/entity-links/repo/entity-edge-source.ts`): `(edgeKey, sourceKind,
sourceId, targetKind, targetId)` with both ends live. It backs the Relations
tab's Connections, the impact preview, the graph explorer's physical edges,
the Problems orphan finder, and MCP `entity_read.connections`. Writes never go
through it.

The orphan finder restricts graph arms to edges touching its checked kinds
before reading rows. Polymorphic source arms remain eligible because their
source kind is stored on each identity. Both endpoints must still be live;
same-kind parent edges connect only their target, so an empty child location
remains a cleanup candidate. This projection does not change Connections or
graph-explorer reads.

Two generic tables carry the relationships and identifiers that used to have a
table each (ADR 0007):

- `EntityLink(kind, fromEntityId/fromKind, toEntityId/toKind, quantity)` holds
  every pure pairing of two entities: `wishCandidate`, `purchaseProduct`,
  `projectTool`, `gardenEntryPlanting`, `productComponent`, `taskDependency`,
  `projectDependency`. Link kinds are declared in
  `packages/schemas/src/entity-links.ts` (endpoint kinds, quantity, self-link and
  cycle rules, per-end role, label, liveness, and merge collision rule). The
  table's CHECKs and the edge-source branch per kind derive from that
  declaration; the write helpers are in `generic/entity-links/repo/entity-links.ts`. Every query
  names its `kind` and filters `deletedAt`.
- `EntityExternalId(entityId/entityKind, source, kind, externalId, url,
  isPrimary)` holds every identifier an outside system gave an entity, and
  `ExternalSource` registers the source slugs. Kinds and the entity kinds they
  attach to are declared in `EXTERNAL_ID_KINDS`
  (`packages/schemas/src/external-id.ts`): product identifiers (`asin`,
  `retailer_sku`, `gtin_14`, …), `settlement_ref` on financial transactions,
  `page` (Notion) and `folder` (Drive). A live `(source, kind, externalId)`
  names one entity; rows soft-delete with their entity. A Vendor may own several
  sources (exports and settlement feeds beside its catalog), but exactly one
  carries `issuer`: Product identifier resolution, exact lookup and import
  fences read only that source. Ownership comes from explicit registration or
  a member action; `ensureExternalSources` registers slugs unowned, since a
  slug's spelling never names a Vendor. Merging two Vendors that each have an
  issuer is refused until one is reconciled, and Problems lists Product
  identifiers held under a Vendor's non-issuer source.
- Research belongs in ordinary editable `notes`: preserve links or record shortcodes,
  relevant excerpts, field/variant context and observation dates as useful prose.
  Notes have no field-support or current/stale contract and do not verify identity.
  Inherited values resolve dynamically through field declarations independently
  of research. Merge preserves both records' notes, retaining original whitespace
  and avoiding exact whole-note duplicates. Purchase folds lock both records
  before reading notes so concurrent research appends survive. Evidence-marked connected views
  remain live relationships in Connected records, including purchase documents
  and accepted/reviewed Emails; they never certify a researched field.

### Collection changes

A field declared with `collection: { key }` accepts patch items on
`entity.update` as well as a full replacement: `{op: "add" | "replace" |
"remove", key, value?, expect?}`. All preconditions are checked before any
change. Text arrays (Product `aliases`, `tags`) patch in the kernel; Product
`externalIds` patches through the Product repository, which keeps primary and
secondary slots, GTIN normalization and global identifier ownership. Add
preserves every identifier and the current primary; an empty slot selects its
first value. Explicit `isPrimary: true` demotes the previous primary without
removing it. Make primary replaces the targeted row's primary attribute;
replacing an identity value uses a targeted remove plus add in one atomic patch,
with the old identity in the remove key. A full array remains a full replacement
for explicit API callers. Ordinary web/native update editors submit keyed patches.
Their single local collection draft keeps an immutable saved baseline and explicit
Add, Replace, Remove and Make primary intent; normalization removes this local
wrapper before input validation and submission. Untouched collections are omitted.
An invalid dirty native draft keeps Save reachable so the existing error handler
shows its diagnostic above preserved input; a valid empty patch remains unsavable.
Create materializes the initial full collection. Record collections declare
`primary: { key: "isPrimary", scope: ["source", "kind"] }` when role controls apply.
Attribute replacements carry the stored URL and primary role as expectations.
Baseline identity keys preserve literal nonbarcode bytes exactly; only declared
barcode kinds use Rust identity normalization, while source follows its slug policy.

Canonical
GTIN digits do not establish the observed UPC/EAN encoding: barcode displays use
GTIN and preserve canonical digits unless encoding evidence is available. Validated
book identities may display ISBN-13. Primary and secondary barcode displays share
shared kind/source/role metadata across web and native; explicit stored URLs remain
links. Committed identifier audit effects retain every changed value and primary
role without truncation.
Audit timeline details render as wrapped literal text; only explicit event links
provide record navigation.
Historical read effects compare URL storage policy directly, without input
normalization or identity repair. Missing committed sides
produce diagnostics rather than an invented empty baseline. Provider lookup links
belong to the applicable lookup workflow.
Product create/update accepts one write-only `barcode` shortcut for barcode or
ISBN input; `primaryGtin` remains a derived read of `externalIds`. Omission
leaves identity alone; null retires only the current primary barcode and the
oldest remaining barcode is promoted. Setting the shortcut selects the primary
without removing other identifiers. Collection replacement stays explicit.
The shortcut builds a collection add/promotion or targeted remove; it shares
the collection writer's collision checks and primary repair.
Find-or-create recovers both database and domain identity conflicts by rereading
the exact requested GTIN after rollback; explicit create/update still refuses
collisions. Provider lookups compact Unicode whitespace and hyphens, matching
the writer while retaining the supplied
barcode width, and translate validated book identity to ISBN-13. The native
specialized barcode control retains ordinary text entry.
Books inference comes from validated ISBN identity in the collection, with
Food evidence taking precedence. Create exposes the barcode shortcut in every
category; ordinary update exposes the identifier collection without a second
barcode draft.

## Classification field policies

A classification decides, per field of the record it classifies, whether a
value is expected and whether it is allowed at all, in one vocabulary
(`fieldPolicyValues`: `required` gaps a missing value, `not_expected` and
`unknown` raise no gap, `not_allowed` also refuses a value). A fixed
classification declares it in the manifest under
`capabilities.classificationPolicies`: the classifier enum, optionally the
classified entity and its reference field (omit `target` when the classifier
is on the governed record itself), and per target field a `byValue` map keyed by
classifier value plus an `otherwise` policy. The generator checks every name
and value and requires a field refused by default to have exactly one
admitting value, then emits `classification-field-policies.gen.ts`. A
household-editable classification keeps its policy per row instead
(SpendingCategory `productExpectation`), and `@cubby/schemas/classification-field-policy`
registers both shapes behind one evaluator (`isFieldAllowed`,
`classificationValuesWhere`, `impliedClassification`). The server SQL evaluator
also compiles column policies against their declared owner table, so inherited
Expense category resolution and policy evaluation share the same path.

ProductCategory `feature` is the first declared instance, resolved through the
Product's category and its nearest bound ancestor. An ingredient or USDA link
is allowed only under Food and an ISBN only under Books; a write carrying one
files the Product under the admitting feature (`impliedProductFeature`), and
field order is precedence, so food evidence outranks an ISBN. A model is
optional across categories; identifier sufficiency is the shared quality rule
described above. Consumers read the evaluator, never a feature literal:
category admission on create, update, merge, and
reviewed reassignment, and decision-model targets — `suggestFields` skips a field the
record's recorded classification refuses (`classificationRefusesField`; an
unclassified record is not refused, since the write classifies it), and
post-import auto-fill re-checks under its row lock. Each declared
classification supplies its effective-value resolver in that server module's
typed `classificationSources` map.

A same-record policy reads the classifier from the governed row. Expense
`lineKind` refuses a product, a stored spending category and a stored project
on every line except `principal` — a tax, shipping, fee, tip or discount line
always follows the split of the Purchase's item lines (shown as "Follows
items") — and `lineBasis: allocation` refuses a product; Location `furniture`
requires its Product; GardenEntry `kind` expects notes on a note and an amount
on a harvest. `enforced: true` (same-record only) makes the generator emit one
CHECK per field into the derived DDL, so every write path is refused by the
database as well as by `assertClassificationPolicies`, which every write calls
first; a field's `refusal` is the actionable message it raises, and its `gap`
names the public data-quality check that reports a missing `required` value or
a present `not_allowed` one. Reclassifying a row clears a stored field the new
value refuses unless the same write sets it, then validates the resulting
record once. Split parts and receipt replacement lines inherit a stored
spending category only when their final line kind allows it. The editor hides a
field the record's classification refuses, and a Suggestion request drops
refused targets, refusing the request only when none remain.

A `relation: true` entry governs a relation the classified record takes part
in instead of a stored field: ProductCategory `feature` admits a Product as a
project tool only under Tools, Tool accessories and Software, and refuses a
Food Product as a Planting source. Relation entries never imply a
classification. Category change, Planting writes, project-tool attach and
Product merge read them through `@cubby/schemas/product-category-relations`,
which entity declarations must not import.

## Product classification and photos

`ProductCategory` is an editable, at-most-three-level tree. `Product.categoryId`
references the most specific known node; its read-only `category` projection
contains the complete root-first path and inherited behavior binding. Products
can stop at any depth or remain unclassified. Filters include descendants.
Names, aliases, descriptions, and display order are editable. Each feature
(Food, Books, Tools, Software, …) is bound to exactly one category — usually a
root, but a nested node may carry its own binding, which overrides its
ancestors' (Tools › Tool consumables). A binding is permanent: it survives
renames and moves and cannot be cleared, replaced, or deleted. Moving a subtree
validates all affected Products against the same identity and dependency
constraints as a direct Product change.

Classification suggestions choose existing taxonomy references using metadata
and retained original-image evidence. Confirmed description corrections take
precedence over model text. Taxonomy contents participate in the proposal
basis, so changing vocabulary invalidates old proposals without rerunning
vision or introducing an inference cache.
Hierarchy-aware placement retains a selected leaf when it carries at least 80%
of the first ancestor branch whose summed probability reaches 0.85. Otherwise
that confident ancestor is proposed; an already selected parent can still use
its subtree probability. A retained leaf keeps its original confidence.
Hierarchy-aware proposals never replace a saved specific category with its
ancestor merely because aggregated branch probability is high. Current target
values participate in suggestion requests and drift checks; sibling corrections,
refinements, and broad classifications for empty fields remain available.
Stored category corrections wait for the current hierarchy projection before
cell or bulk acceptance; stored ancestor downgrades are withheld as well.
Suppressed live ancestors report a non-pick outcome with no calibrated decline
probability, so outcome summaries never count them as proposed changes.

Manifest-declared suggestion targets appear as field pills in entity lists.
Pending Suggestions and confident live answers both appear in those cells as the
same shared suggestion-mode pill; one tap accepts. Each live suggestion
question is keyed by one target's declared basis, current assignment, and relevant
resolution context. Deferred sibling projections and unrelated assignments do not
restart it. The page-mount Run key attributes calls but is not part of that key,
so remounts within the cache window reuse answers. A live decline (`none`) or
`no_signal` answer is remembered per basis and the field's decision-policy
stamps, with a signature of the decision inputs it read; a later decline of
the same question replaces that signature. After the stored read, the page
asks about the questions it left uncovered in batches of up to 50 through its
database limiter. Each remembered question's inputs are re-prepared from saved
data without the model or any paid provider call, so a changed roster (a new
Category or Project), linked record or stock tally reopens it just as a basis
edit does; inputs that need a provider (a cold query embedding) cannot be
verified and are asked live under a fresh revision on every read. A reopened
question's live ask carries the read's input revision (the new input
signature, prefixed by the member review that marked the decline a miss
when there is one), so an answer
cached for its old inputs is not reused. Replacements are serialized per
question, and the newest memory row wins. Existing outcome variants retain optional `reviewStatus: "rejected"` when a retained member rejection withholds the proposal. First reads return known skipped source states (`no_signal`, `no_candidates`, or `resolved`) without inventing evaluation history. Member reviews and writes to the
entity kinds a question declares (its entity, the field's vocabulary,
referenced basis records) recheck mounted questions; a roster that reads a
kind outside those tags is rechecked on the next page read, not live on a
mounted page.
Questions with saved finance context (`entityId`), pinned-model replays and
declines a member marked as a miss are always asked again.
Every saved-record live answer (`savedRecord` with `entityId`, finance and
vendor context included) is also remembered after review withholding as a
complete preview — proposal, weak pick, decline or skipped state — keyed by
entity, record, field, basis mode, basis and the field's decision-policy
stamps. A `read: "preview"` settled read returns `preview` from one policy read
and one memory lookup; it prepares no inputs, calls no model, schedules nothing
and opens no Run. It omits previews whose assessment was rejected, superseded,
rejected through the same served evidence, or marked a miss by a member. Pinned
replays and form drafts never write previews. A list reads previews for every
candidate question, so a row waiting on its verified settled read or its live
ask shows the cached answer, including a below-threshold or declined outcome,
while it checks. A preview is display-only: accept, reject, a different value
and the suggestion count wait for the live answer, which replaces it. A live
failure replaces it with the raw error.
The page batches stored Suggestion reads and retains completed rows
while an expanded roster loads; only newly seen rows wait. Pending state and read
errors belong to the affected field, and background refreshes retain usable answers.
Acceptance immediately shows the proposed value with a saving indicator in that
cell, preserves unrelated pills, and hands off to the saved projection when it
arrives. The accepted field stays settled for the visit until its dependencies or
saved value change, rather than immediately asking for a correction to the new
assignment. Failed writes restore the proposal and show the raw diagnostic. Live
acceptance still rechecks authoritative saved inputs before writing; changed
declared dependencies require a new question. A refused finance fingerprint
refreshes only the affected question. Stored acceptance completes after
its write, without awaiting unrelated list refreshes. Every field-suggestion
surface opens the same suggestion body (`entity/suggestions/suggestion-body.tsx`):
Accept / Reject (with "Use a different value…"), confidence as "92% · high"
(`formatConfidence`), the runner-up and its probability, the basis fields the
model read, and a provenance caption (model, Run, time, AI usage). Jev and Clef
return no prose, so those facts are the suggestion's reasoning. A tree suggestion
keeps the model's selected category and confidence; ancestor probability is not
substituted for a leaf decision. Ancestors of the current category stay suppressed
as correction offers. Weaker live proposals stay
behind the cell's mark. Percentages describe model confidence, not a
guarantee of correctness. Accept shows local saving feedback; completed row
enrichment stays visible throughout same-query refreshes. A changed target, declared basis or backing field supersedes its older pending Suggestions, and a later sweep supersedes prior pending rows
for the same record and field. Suggestions remain available to evaluation after
review.

### Shared proposal queue and automatic decisions

The `/suggestions` page lists actionable proposals from fields,
statement transactions, connections and recommendations (including tag additions
and placement moves), Product pairs, image descriptions and transfer pairs on one server-filtered table
(`suggestions.list` over the family registry in
`server/generic/assessment/repo/suggestion-families.ts`): family chips with counts, each family's own columns,
inline evidence, keyboard review (↑/↓, →, A, D), a confirmed "Accept N clean"
that re-lists before each chunk, bulk Dismiss and Never suggest (no bulk
Wrong), and Find suggestions, which estimates and starts a Sweep. A
collapsible Automatic rules section lists each rule's state, measured
precision and member switch (`suggestions.rules`/`setRule`; On only when
eligible, Off after a confirm). Its `family`, `record` (`<kind>:<CODE>`) and `runId` params scope it.
Every entity list batches the same queue's pending counts and opens its shared
inline review; detail pages show a scoped Suggestions section. Family declarations
expand every affected record: both endpoints of connections and pairs, reference
values of fields, and a statement row's account and candidate Transactions.
Non-actionable Product pairs remain ordinary history. A merge still requires
explicit survivor and impact confirmation, and identity conflicts cannot merge.
Tag proposals retain the source and every supporting Product's revision; listing,
publication and confirmation recheck those revisions and the supporting tags.
Older count-only and stale tag advice stays stored with its existing status and is
excluded from the queue; a later Sweep may publish a proposal with a new basis.
Project, placement and tag proposals appear after a Sweep publishes them; passive
record reads never discover or publish new advice.
Similar-Product browsing stays informational; photo-import choices stay in their Run.

Suggestions' **Automatic decisions** tab is the optional generic audit, newest
first, with family and review-status filters. `/automatic-decisions` redirects
there, preserving record and audit-family scope. It also appears on each affected
record's detail page. Email relevance, automatic Email links, mail-import outcomes
and automatic-rule application receipts enter through declarations; member-made
Email link decisions remain ordinary history. Report incorrect records Wrong
Feedback through the existing family path, without applying a correction or
pausing automation. Applied effects remain; affected records link to their domain
actions. Feedback participates in supported later reassessment without promising
historical record repair. Wrong and corrected decisions remain in the audit.
Legacy Email predictions without application receipts are included with
**Unverified application**, even if they disagree with the Email's current relevance.
New ingestion records observation and application receipts atomically with routing;
known unapplied predictions stay ordinary history. Observation receipts coexist
with member Feedback: readers select the intended operation or authority instead
of assuming Feedback row order. No status reset or backlog cleanup is needed.
The former automatic-application URL redirects to this audit, and
Workbench bookmarks redirect to the shared queue or informational Product detail.
Apple queue/audit/list/detail parity is tracked separately in [#2654](https://github.com/nickysemenza/cubby/issues/2654).
The `/ai`
page's Decisions tab catalogs every decision's basis, options, rules and
rendered request (`ai.decisionCatalog`) with a Jev/Clef Try panel. The
household's Work has one row per Suggestion family linking into the page,
and a Sweep Run's detail links to its own.

### Automatic semantic classification

Automatic semantic classification uses the same declared Decision features:
receipt roles, UPC offer comparability, weak image provenance, and Product
title variants. Authoritative assignments bypass inference. Valid uncertainty
abstains without inventing a value; provider and malformed-response failures
fail the operation. Classification is prepared before business publication,
which rechecks the evidence and stronger assignments. These changes apply when
workflows next run; existing classifications and cached lookups are not
reclassified automatically. New features also register their production adapter
in the AI smoke catalog so the generic `/ai` form can exercise them.
Image source Decisions record `sourceEvidence` separately from capture evidence;
they establish neither a photographer nor a capture time or location. Existing
manual, strong sighting, import, and meaningful EXIF evidence retains precedence
over weak metadata. Processed metadata without capture facts and weak library
membership remain eligible source evidence; neither establishes ownership alone.
Entity lists expose a generic pending-suggestion filter (any, Addition, or
Correction) and can start a sweep across every declared target using the list's active filters.
A Sweep freezes matching record/field membership and its selected model at launch,
then returns a Run immediately. Background Workflows resume from durable target
receipts, rechecking current values and member field writes before publication.
Pause and resume use Run status; transient failures retry within a bound and
terminal failures remain visible. Paired trials and finance acceptance rules
remain part of the workload. Identical pending targets can share execution while
each requesting Run can inspect the published Suggestions and keeps its own receipt.
Product identity scans enumerate the full live catalog under AI-refresh activation.
Canonical pair work shares frozen evidence and the actual served producer through
existing durable evaluations; a completed catalog enumeration does not claim that
queued model comparisons have completed. Exact retained source claims publish rule
Problems independently of model availability. Registered identifiers retain their
single owner: only accepted originals with actual Product bindings establish
additional claims. Shared model/style names, URLs and partial variant text remain
retrieval or recommendation evidence.
Retained claim loads resolve issuer ownership from one operation-local Vendor and
source-registry read, rather than repeating those reads for each accepted line.
Later operations and registration writes read current registry ownership. A line
whose issuer cannot resolve (an ambiguous host, incompatible ownership, a
non-HTTP page) drops only that claim; the catalog scan records the raw error,
the Product and the page in the evaluation result's `coverage`, beside whether
vector neighbour retrieval was queried, unconfigured or failed.

Product Category describes identity and can supply a Spending category mapping
through its ancestry. Cost type describes the Expense's accounting role; Trade
describes the work context. Product Category does not infer Trade. Reviewed
Product category reassignment previews historical spending, fingerprints selected
Products even without Expenses, and revalidates before audited transactional
writes. Explicit Expense categories and Purchase defaults keep their precedence.
Food feature transitions require a broader Project/Trade review and are refused
by the spending-only workflow; identity normalization cannot substitute a target
different from the reviewed one. Lazy field explanations return bounded hierarchy
and fallback-source evidence so clients do not reconstruct these rules.

Web field explanations keep one compact hierarchy across quality, derived values,
and inheritance: the result and interpretation lead, followed by applicable checks
and source evidence, then technical metadata. Check rows distinguish missing data,
defects, and accepted exceptions with labeled semantic badges; weights and caps stay inline; check identifiers and raw evidence remain available in Technical details. Satisfied checks collapse into a green labeled summary; gaps use amber and defects red, with labels carrying the meaning. Repeated owner gaps are shown once through the check rows, while related-record gaps remain separate. Inheritance ladders align source, value,
and precedence, allow long values to wrap, and emphasize the winning source.
Resolvers return the selected value and its evaluation trace together. Traces distinguish
used sources, unresolved decisions that block fallback, absent or disabled sources that
permit fallback, and alternatives evaluated but overridden. Observed inputs retain source
links and current policy settings; they do not invent historical intent. Coverage reports
shown and omitted rows, inventory branches, and inputs. Each independent contributor
contains its own chain, typed decision steps, and coverage; row indexes address that
contributor chain, including its summary row. Ownership evidence includes at most
50 inventory contributors, 50 decision steps per chain plus its contributor summary
row, and 50 observations per step. Record labels are batch-loaded across the visible
contributors so query count does not grow with inventory entries. The same generic evidence view
serves populated and empty fields on list and detail surfaces, with exact inputs available
under Technical details. Observation `fields` name declared source fields whose own
explanation and controls are available alongside the record link. Editable stored fields
receive a direct-value explanation; native detail retains explainable empty fields.
Stock-tracking resolutions retain their evaluated category chain and fallback source even
when a Product override wins.

Product Owner explanations expand each inventory entry's assignment and acquisition
stack. Acquisition-only owner labels say "from purchase"; purchaser, beneficiary, funder,
and account holder retain their separate roles. Entirely unknown beneficiary shares permit
account defaults; partially named, conflicting, split named, and named Household attribution
retain the blocking semantics owned by the terminology guide. Unknown ownership is not
explicit Household ownership.

Product Locations retain their links and add a server-composed inventory status. Status
combines tracking policy, installed Location presence, recorded acquisitions/exits and
comparable inventory counts. No quantified history differs from a supported zero balance;
unknown kit quantities also keep history incomplete. Exact discrepancies require complete
quantity history and inventory in each units. The variance column, SQL filters/sorts,
picker/recount summaries, and location captions share that comparability rule. No status implies automatic consumption or
disposal, and disabled tracking never removes manual inventory. Declared relation sections
may place unique detail `contextFields` above their table; Stocked at uses this for the same
inventory status and its expandable evidence. Native default list rows also include
relation context fields marked for list display, even when the separate web column
is hidden because another column embeds that context.

Resolution order uses the shared records block's `timeline` presentation for
precedence, not chronological history. Every nonempty chain remains visible,
including a single subject or steps without record links. Explanations include
unset candidates and overridden fallbacks; allocated values expose contributing
records with each record's own expandable precedence chain. The server supplies
the outcome so mixed contributions, unset values, and blocked mappings do not
collapse into the same null display. Intentional domain nulls retain their field
labels. Clients collapse long chains and contributor lists and disclose bounded
evidence even when no ordinary source rows exist. Evidence and authoritative
resolution are read in the same snapshot; clients never reconstruct precedence.
Structured resolution evidence owns the readable value: do not repeat its raw
object or resolved-list payload underneath it. Owner rollups show one readable
row per Inventory entry instead of nested label/reference/boolean facts.
Reset and navigation actions remain in the popover footer, while exception actions
stay with their check. Tables retain their compact rows and lazy explanations.
The sticky footer stays wholly inside the scrollport so its actions retain their
phone touch targets. Nested evidence switches from aligned facts to stacked labels
based on its own container width, avoiding progressively narrower columns. Generic evidence values link validated HTTP(S) URLs, format ISO timestamps in the household zone, and use calendar-date context for plain dates. Bounded evidence IDs resolve in one identity batch to canonical public codes and then shared entity links, which resolve record names when evidence supplies only a code. Identifier source links use the registered `ExternalSource.vendorId` owner, including host-based slugs; a slug's spelling never establishes Vendor ownership. External identifier values remain literal through rendering even when they match an entity UUID, public code, or source slug. Unregistered row IDs and unowned source slugs remain literal. Technical details is collapsed by default.

An Image has provenance (`own`, `catalog`, `unknown`, or `screenshot`, plus
optional supplying source name/page/asset URLs). Its Product attachment has
nullable purpose (`item` or `label`). Unset legacy purposes keep their
existing gallery behavior; labels are supporting evidence and cannot supply
direct or borrowed covers. Product reads retain separate item and label
arrays with attachment purposes. MCP detail exposes all attachments, while
`imageCount` counts every attachment for upload preconditions and item/label
image counts count displayable images. A cutout is a rendition of one Image:
original bytes remain the analysis source and fallback, and the original can
be selected explicitly.

An Image's _who took this and when_ is derived, never entered directly.
`ImageSighting` — a non-entity child table of Image, with no shortcode and no
identity row — records each report that a stored Image appears in one Ledger
Party member's photo library or cloud asset store, from one reporting
`Device`. It is unique per `(imageId, ledgerPartyId, assetKey)`, so a member's
second device reporting the same synced asset updates the existing sighting
rather than creating another one. Sightings are written only through
`image.recordSightings` (and a photo-import commit's `library` block), read on
the Image detail as `sightings`, and their audit history lives on the parent
Image. `deriveImageCapture` reduces an image's
live sightings, and failing those its embedded EXIF, to Image's own
`capturedAt`, `captureLocation`, `capturePlaceName`, `captureDeviceLabel`, and
`capturedByPartyId` fields, recording how confidently in
`captureAttribution` (`none`, `derived`, `ambiguous` when several members'
evidence ties, or `confirmed` once a member sets it by hand — confirmed is
never recomputed). Every sighting write or reporting-device delete re-runs this
derivation for its image in the same transaction. See ADR 0005 for the full
precedence rule.

## Adding an entity

1. Add one typed `.entity.ts` declaration with field validation, storage, mutation
   policies, presentation, capabilities, and logical relationships.
   `presentation.titleField` must resolve to a non-nullable text read field;
   if the entity's natural title can be empty, declare a storage-less
   read-only `displayName` field instead (see above) and point `titleField`
   at it rather than at a nullable name column.
2. Add its branded id, declare its table's indexes, checks, and Drizzle
   relations in `storage`, and compose canonical input/output schemas from
   the generated factories. Keep domain refinements and relationship
   projections explicit. A physical change still requires a migration that
   carries existing rows; generation does not apply production DDL.
3. Declare its repository with `defineRepository(entity, { get, list, … })`
   (`apps/web/src/server/entity-kernel/repo/repository.ts`) and point
   `extensions.ports.repository` at the export; the generator binds it to
   the kernel. Methods take the kernel context (`(ctx, …)`); the declared
   actions gate which ones the kernel exposes (`capabilities.lifecycle:
   "readOnly"` exposes get/list/search), and `delete` defaults to the
   declared `lifecycle.delete` policy plus `deleteHooks`. The kernel owns the
   write transaction: a repository writes through `ctx.db` and never opens a
   transaction on another handle. A declared `capabilities.resolve` needs no
   code: `resolveEntity` serves it from `entity-kernel/resolve.ts`.
4. Set `route.basePath` for the generic pages (`route.list: null`
   hand-writes the list route module; detail is always generic, with
   specialized UI in detail slots); add workflow extensions where needed.
   Every `many` relation gets a detail table and every FK a derived inverse
   unless you omit it with a reason (`detail.omitRelations`, `inverseOmit`).
5. Run `pnpm generate`; review generated source like handwritten source.
6. Declare physical edge semantics and operation-specific lifecycle policies,
   when the entity participates in deletion or merge. A new shortcode table
   gets its identity FK and shortcode index generated; the identity
   triggers follow the roster automatically, and the production cutover for
   an existing database must backfill `Entity`. A new join or child table that
   carries an edge column names its owner in `ENTITY_EDGE_OWNERS`. A new
   many-to-many pairing of two entities is a kind in `ENTITY_LINK_KINDS`, not a
   new table.
7. Run generated action contracts and the affected PostgreSQL contracts, plus
   UI and built-browser checks for changed presentation. Follow the repository
   validation guide for final gates.

The compiler owns mechanical catalogs and capabilities. Repositories retain the
handwritten transaction seams until their ports can be generated without
weakening domain invariants.

### Cross-platform option colors and roster counts

Enum presentation is authored in the owning roster. Field display metadata
`optionRole`, `optionColor`, and `optionGlyph` supplies explicit defaults for
`control.options` or `display.valueOptions`; each option may override its color
or glyph. Colors are keys from `packages/design-tokens/tokens.json`, such as
`domain-house`, `positive`, or `neutral-status`. Status rosters use condition
tones, whose standard glyph is an explicit shared default. Category rosters
choose contextual glyphs and stable colors; several values may share a mark.
Unknown choices explicitly declare neutral presentation.

`compileEnumOptions` completes and validates presentation once, with errors
naming the entity, field, and option. Read-only enums declare `valueOptions`
instead of deriving presentation from Zod values. Zod enum coverage is checked
against the roster. No value spelling, array order, or color infers semantics.
The compiler projects token keys into the existing cross-client CSS-token wire
form and generates static browser icon imports from the used glyphs. UI-only
sentinels live with their web option declarations. Renderers draw resolved
presentation without rerunning completion. The design-token generator supplies
both CSS and Apple's adaptive color assets, including named domain hues.
Color supplements the visible label.

Specialized surfaces, including task-board trade badges and native journal
rows, resolve the same field option color instead of choosing their own badge
variant or tone.

`dashboardLocalCounts` owns the local navigation-count roster, including
Spending Categories. The server count query and web navigation derive their
keys from that schema, rather than separate supplemental entity lists. Each
server entry uses its entity's unfiltered list predicate. Missing responses
remain absent; loaded zero counts remain visible.
