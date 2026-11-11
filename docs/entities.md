# Compiled entities

Cubby's ordinary entity surfaces compile from typed declarations in
`packages/schemas/src/entity-definitions/*.entity.ts`. One generator turns them into web, native,
HTTP, MCP and server artifacts. Load the one section a task needs:

- [Declarations and generation](#declarations-and-generation): Declaration shape, field model, storage, ports, import boundary, generated rosters
- [Generic by default](#generic-by-default): Rules for adding behavior; [entity capabilities](#entity-capabilities)
- [Field resolution and overrides](#field-resolution-and-overrides): Field envelopes, inherited values, resets, nested references
- [One declaration, several consumers](#one-declaration-several-consumers): Presentation, detail sections and summary, reports, native coverage, Emails sections, [bulk edit](#bulk-edit)
- [Images and display sources](#images-and-display-sources): Image storage kinds and borrowed display images
- [List presentations](#list-presentations): Boards, embeds, named groupings, calendar
- [List columns and display](#list-columns-and-display): Renderers, column defaults, trees, sorting, saved views, option colors
- [Grouping, pivot and totals](#grouping-pivot-and-totals): Group by, memberships, summaries, Pivot, evidence metrics, selection
- [List reads](#list-reads): Server list and detail read contracts, write receipts, read timing harness
- [Filters and search](#filters-and-search): Search, filter semantics and compiler, derived list fields, row sets, scopes
- [Background derived data](#background-derived-data): Stored results, SQL views, the hourly pass, completeness
- [Runtime interface](#runtime-interface), [Workflows](#workflows), [Transports](#transports), [Browser cache policy](#browser-cache-policy): Kernel entry point, workflow runtime, operation dispatch, cache tags
- [Child storage](#child-storage): Child and module tables, storage retention
- [Data quality](#data-quality): Stored checks, scores, exceptions, Research and Work queue
- [Relations, deletion, and merge](#relations-deletion-and-merge): Relationship authorship, lifecycle, delete and merge
- [Connected records and graph](#connected-records-and-graph): Graph exploration, connection catalog, merchant labels, [Product connections](#product-relationship-route)
- [Identity, attachments, and the physical graph](#identity-attachments-and-the-physical-graph): `Entity` rows, attachments, links, external ids, [collection changes](#collection-changes)
- [Classification field policies](#classification-field-policies): Expected/allowed fields per classification
- [Product Brand and Purchase Seller](#product-brand-and-purchase-seller): Vendor roles
- [Product classification and photos](#product-classification-and-photos): Categories, services, image provenance and capture
- [Suggestions](#suggestions): Field suggestions, storage and review, [shared proposal queue](#shared-proposal-queue-and-automatic-decisions), [Sweeps](#sweeps), AI field refresh
- [Field explanations](#field-explanations): Why-this-value evidence presentation
- [Adding an entity](#adding-an-entity): New-entity recipe
- [Related records](#related-records), [Household maintenance view](#household-maintenance-view): Relatedness rail; maintenance slot

## Declarations and generation

Each declaration uses real Zod schemas for read, create and update modes. The generator imports
the modules and emits references to the declared schemas; it never serializes Zod internals or
reconstructs refinements.

`definition.ts` owns the strict metadata schemas and their inferred declaration types. Each module
exports `{ definition, readSchemas }` from `defineEntityModel`, which infers source fields and
optional read composition before relationships. `defineEntity(definition, relationships,
readSchemas)` then resolves source-owned relationship handles. Raw-read facades import the named
`readSchemas`, never the completed entity, so read inference does not depend on the relationship
type graph. The constructors preserve field literals and check reference targets and cardinality
against branded identifiers in every mode. References may project identifiers or records with a
branded `id`; related-record counts remain scalar projections; storage-only references need no
public schema. Identifier policies own sentinel admission: `identifiers.currentMember` allows
requesting-member references, and related-view filters derive their schemas from that policy.

The compiler parses metadata and applies defaults before typed compilation. Cross-entity
references, capability compatibility, field rosters and physical storage are semantic compiler
checks; field-validation Zod instances pass through unchanged. Declaration loading and artifact
generation share one effective compilation pass: it captures explicit overrides before deriving
image sources and inverse relations, derives detail sections before validating data-quality
placements, then validates the whole graph against entity and module child storage. Image routing
names actual model fields; disabled create routes do not count as alternatives. Counterfactual
comparisons use the same pass for named overrides.

Ordinary stored entities without a repository override derive editor intents from field write
eligibility and identifier filters from their stored reference fields; explicit descriptors keep
domain filtering semantics. The shortcode and entity-reference parsers consume the generated
identifier catalog, with no enrollment map. Test factories derive creatable entities and title
filler from the same contracts. Browser definitions and static icon imports derive routed defaults
from declarations; renderer coverage requires only declared custom renderers; data-quality
rendering is shared across scored entities; search consumers use the declared entity key.

Compiler renderers use bootstrap-safe entity and identifier leaves, never their own generated
catalogs. Shared Problem query and action declarations live in `entity-definitions/problems`; the
runtime compiler and registry validation live in `server/generic/problems/repo`; browser Problem
modules own rendering and continuation loading. The shared filter compiler lives in schemas and URL
keys come from generated list fields, so server readers import no browser filters. The lean
Problem classification is emitted from the canonical detector catalog after entity schema artifacts
exist, so a clean checkout needs no prior output.

The declaration is authoritative only for declared mechanical behavior. It does not replace a
repository's transactions, locking, SQL or workflow rules.

### Field model

The model owns scalar validation, physical column factories and presentation. A concrete
`validation.create` or `validation.update` grants that write mode; null or omission excludes it.
A create-only field submitted to `entity.update` is refused with its field description.
Fields enter the raw base read by default; `output: false` excludes storage-only and write-only
fields. Writable fields audit by default; `audit: false` records an intentional exclusion and
`audit: true` retains read-only evidence. The compiler derives the create/update/output/audit
arrays in field order; separately authored rosters are rejected. Generated storage enums reuse the
field validator; stored JSON representations declare their type reference on the storage entry.

Use ordinary Zod composition and spell out each mode:

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
}
```

An omitted or null mode has no schema. Zod owns optionality, transformations, nullability,
descriptions, refinements and defaults. Put create-only defaults on create schemas, and make partial
update schemas explicitly optional so omitted values preserve data. Schema maps reference these
exact objects. `field-policy.ts` owns shared timestamp validation and alias normalization: alias
writes trim, drop blanks and deduplicate exact strings in first-seen order; read schemas retain
historical stored values. Collection patches keep exact-key preconditions and normalize the
completed list through the update schema. Use `timestampField` and `readOnly` instead of copying
validation triples.

Field defaults are non-nullable, a label humanized from the key (a reference drops its `Id`; a
`<field>Presence` filter field reads "<Field> present"), and a read key equal to the key. Use
`label` for a different label and `readKey: null` for fields without a scalar read projection.
Missing controls expose no editor. Omitted display flags derive from each effective surface schema:
the value or reference identity must exist and have a supported rendering. Explicit `false` omits
an eligible field; explicit `true` cannot admit an unavailable one. Default-equal flags, labels,
read keys, column ids and list orders fail compilation. Fields consumed as another field's label or
item list default to hidden on both surfaces. A reference defaults to one entity. The compiled
manifest retains `columnId`, `detailOrder` (title first, then model order) and `listOrder`.

Generic MCP inputs reuse the canonical create/update contracts. MCP output contracts name their
audience-specific projections, which can extend canonical outputs; specialized tool digests keep
their own projections.

### References

Use **reference name** for a linked record's human name and **display label** for composed
presentation text. A reference normally projects `<stem>Name` or a nested record's `name`; a custom
label declares `display.labelPath`, which web and native reference renderers read before the
conventional name while preserving the target's identity. Never put an identifier in a label
projection. A governed envelope keeps its declared label path: path readers resolve the canonical
result, and renderers use a projected name only for its matching id.

A reference may declare `multiple: true` and an ordered `scope` mapping each sibling form
`sourceField` to a `targetField` filter on the referenced entity. The compiler verifies both ends;
generated editors wait until every scoped source has a value before querying, so an incomplete form
never widens the candidate set. Scope constrains discovery, not stored values: existing selections
stay visible and removable when they no longer match. Candidate filters and dependent scopes apply
in capture forms, inline detail editors and table cells through the same picker provider; an
inline editor must not widen a declared member-only roster.

Reference filter declarations (`brandRef`) own deferred option feeds. The generic list hook
supplies ordinary rosters; `brandRef.optionsKind` keeps an existing scoped roster (Locations with
inventory, Ingredients with Products, Products serving as Locations). Feature column overrides do not
wire those feeds; counted and tree rosters remain explicit runtime overrides.

### Table storage

A storage string uses the field's kind and nullability, the key as column name and no database
default. An object such as `{ key: "importedAt", defaultOverride: "now" }` overrides only the
differing facts (`nullableOverride`, `defaultOverride`). Stored-field order is explicit.
Presentation defaults never grant mutation capabilities or introduce columns.

The top-level `storage` block owns the rest of the table. The generator emits canonical Drizzle
`pgTable` definitions separately from `relations()`: definitions live in
`generated/entity-table-definitions.gen.ts` and the FK-closed identity group;
`generated/entity-tables.gen.ts` assembles relations and re-exports definitions;
`server/db/schema.ts` exposes both. `storage.columns` adds operational columns no field declares;
`indexes`, `checks` (a named SQL check, or a value-set check defaulting to the field's read enum) and
`relations` (`with: {}` names; a string is a reference column) name columns as `{columnKey}`.
Derived without declaring: the shortcode unique index, the identity FK to `Entity(id, shortcode)`,
and a `<Table>_<column>_idx` index on every reference column no full index leads with
(`unindexedReferences` opts one out with a reason). Constraint names are part of the committed
migration snapshot; never rename one casually. Fields declared `enum:inheritance-mode` derive their
values from the field's Zod schemas. Source generation never changes stored data; physical changes
need their own preserving migration under [domain rules](agents/domain-rules.md#production-changes).

### Extension ports

`extensions.ports` is the explicit seam map for entity-wide behavior the compiler must not infer:
the kernel repository binding, entity label and shortcode resolver, filter declaration,
search-document projection and text hooks, field-envelope projectors, report dependencies and the
custom timeline. Each entry is a `{ module, export }` source reference, or `null` when the port is
intentionally absent or a workflow-only seam. `ports.search: "document"` selects the standard search
projection; use explicit references for a different implementation. Search presentation branches
use current shared kind values. Mutable relationships declare their item schema, repository
adapter, source and browser/MCP exposure on the relationship itself. The generated inspector
projects these references as client-safe data; generated server bindings import executable adapters;
repository closures still own transactions and service injection.

`extensions.ports.reports` binds a domain's report dependencies. Generation emits the per-entity
loaders into `entity-kernel-bindings.gen.ts`; the eager mutation and list assembly lives in
`entity-kernel-runtime.gen.ts`. The generic report runner executes the dependencies with a
request-scoped memo; domain builders, including collection presentations, live with their domain,
while summary and record blocks stay generic. The override inventory compares remaining named
overrides with inferred defaults; labels, read keys, column ids and order are plain options.

### Generated artifacts and import boundary

Declarations may import shared primitives and cycle-safe field modules. They must not import
canonical schemas, generated artifacts, server implementations or browser modules; implementation
references remain `{ module, export }` data. An oxlint `no-restricted-imports` override on the
declarations and the helper modules they import guards this (`.oxlintrc.json`); a helper a
declaration newly imports joins that override's file list, and `generator/entities/import-boundary.ts`
fails generation when the transitive graph reaches an uncovered file.

Canonical validators are generated in per-entity schema-binding modules; the aggregate imports those
instances rather than rebuilding them. These modules contain only schemas and data, so client types
reach them without server code. Nested-envelope metadata is imported separately from validators.
Browser metadata is generated separately and contains no executable schemas: the public
`@cubby/schemas/entity-metadata/*` alias and the compiler-only
`@cubby/schemas/compiler/generated/entity-metadata/*` alias select the same per-entity slices, and
the generated browser loader imports them lazily, never declarations or compiler closures. Document
QueryClients own admitted bundles; see
[metadata transport](../apps/web/docs/web-runtime.md#entity-metadata-transport).

Install runs generation before generated files exist, so static generator inputs cannot execute
schemas that consume generated output. Shared presentation vocabulary such as `activity-fields.ts`
owns primitive enums and labels so runtime and native generation share them without a bootstrap
cycle. Cross-client input limits live in bootstrap-safe `shared/client-constants.ts`. The generator
emits the AST-derived shortcode registry and a type-only index of declaration bodies before
importing read-schema compilers; declaration source paths and errors live independently of compiler
initialization. Declaration helpers import shared constants from their leaf owners, and runtime
compiler imports take entity vocabulary from `entity-core`, not the `entity` facade. Warm local
outputs must not hide a bootstrap cycle.

```bash
pnpm generate
pnpm check:clean
```

One generator (`apps/web/generator/main.ts`) writes entity artifacts, then the operation registry,
lazy handler data and MCP data, then shared HTTP transport artifacts with their native derivations.
Generation rejects invalid metadata and unsupported capabilities. Generated app output is never
committed. TypeScript emitters use `tsModule` in `generator/artifacts.ts`, whose vocabulary is
imports, exported literal constants (`as const`, optionally `satisfies` a named type), aliases of
named types and re-export aliases. Literal tables may reference imported values but never call
them, except a `bindings` entry: an imported, side-effect-free factory applied to imported
references. Behavior, Zod construction, mapped types and parsing live in ordinary typed modules
under `src/`. Unmigrated emitters mark free-form source with `rawSource()`.

Generated detail and list type maps derive from schema maps, preserving each entity key's
input/output correlation; they stay separate from browser metadata and server bindings. Browser and
server read contracts consume generated entity tuples; the typed read factory owns filter
validation, tree extensions and list outputs. Explicit list-item schema ids preserve native
`<Entity>ListItem` names. HTTP and MCP project one kernel capability owner; MCP is an explicit
subset. The generated summary lists read dependents from reference fields, derived paths and image
fallback paths (including transitive media inputs); notifications add those consumers' cache roots
without recursively applying mutation ripples or scheduling Jobs. List responses share one metadata
schema across entities and clients.

### Rosters and routes

The **list roster** is every routed entity with a contract: its index (generated, or hand-written
like Image's) and every client read the kernel's complete list, whether or not the browser writes
the entity (Cookbook, Image and Run are read-only). Specialist `listColumns` never change where rows
come from; existing ones declare `route.listColumns: { module, export }`, which only that route's
component split imports; new columns still belong in the generic declaration. Only a generated
index feeds inline relation tables. The **CRUD roster**
(`generatedBrowserCrudEntities`) is the list-roster entities with create and update contracts;
mutation results key on it. The generic editor accepts entities with declared create or update
intents; an update-only entity exposes no create operation.

List and detail route modules are generated by default; a `null` slot keeps the module hand-written.
Every detail is the generic page over the kernel `get`; the generator rejects `route.detail: null`
except for `recipe` and `usda-food`. Specialized screens are detail slots gated in shared shells.

All entities mint five-character shortcode bodies; validation also accepts four-character bodies.
Length is not a declaration option. Inbound-only `P-`/`L-` label aliases live only in
`packages/shared/src/shortcode.ts`. Computed titles stay null in shortcode bindings and resolve
through the shortcode resolver's explicit label overrides, so resolving a label does not load the
field model. `model.intents` owns browser editor field fragments; a declaration module must not
export `filterSchemas`, because a `deriveSchema: true` filter descriptor owns its field's Zod.

## Generic by default

Cubby's entities share one declaration spine, and every client — web, iOS and macOS, HTTP
operations, MCP and the server — needs as little hand-written per-entity code as possible.

- **Manifest first.** Entity behavior (fields, shapes, filters, sorts, list columns, edit intents,
  validation, relations, saved views, presentation) is declared in
  `packages/schemas/src/entity-definitions/*.entity.ts` and generated for every client. Add a
  capability to the declaration and the generic renderer/runtime, then delete the per-entity twin;
  keep a remaining exception explicit in the declaration or a typed hook registry.
- **Same shapes everywhere.** Entities reuse field names, kinds, display formats and record shapes
  (ids and shortcodes, timestamps, notes, tags, images, provenance, money). Reach for an existing
  kind or format before inventing one.
- **Derive types; never restate them.** TypeScript types come from Zod (`z.infer`), generated
  manifests, Drizzle, or `Pick`/`Omit` of those; Swift types come from the generated operation
  models and entity manifest. Cross-Worker RPCs share one Zod contract.
- **Generate over hand-write.** Code that is a function of declarations or contracts belongs in
  `pnpm generate` output with a drift check.
- **Reuse before writing.** Search [generic paths](agents/generic-paths.md) and the codebase for an
  existing helper or generic path, and extend it rather than fork it.
- **Finish migrations.** A change that introduces a generic path moves every caller in the same
  change. Only a migration too large for one PR records its remainder in a shrink-only baseline and
  a GitHub issue. Lint rules in `tools/oxlint/cubby/` and shrink-only boundary tests enforce the
  common cases.

### Entity capabilities

Each entity feature has one owner and is adopted on the entity's declaration. The compiler expands
it for web, MCP and native; `capabilities.dataQuality` is the model. "Beyond the declaration" lists
the code an adoption still needs, and why.

| Capability               | Declare                                                                 | Beyond the declaration                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeline                 | `capabilities.timeline: "default"`                                      | None. `custom` binds `extensions.ports.timeline`. Agents read change history through `activity_read.list`.                                                                                    |
| Relations                | `r.field(...)`, `r.path(...)`, `r.link(...)`, `r.images()`              | None. A `many` relation with no id filter on its target declares a section filter or `detail.omitRelations`. New edges need their stored column.                                              |
| Bulk edit                | A field's `validation.update`                                           | None. The roster derives from update fields, excluding names, identifiers and attachments.                                                                                                    |
| Borrowed display images  | `capabilities.images.displaySourceOverrides`                            | None. List, detail, MCP and native read `displayImages`.                                                                                                                                      |
| Gallery and cover images | `capabilities.images.storage`, `image-fields.ts`, `r.images()`          | The entity's writer calls `syncEntityImages`, its delete policy states the attachment disposition, and `attachmentAssociation` names it. Deletion stays an explicit choice.                   |
| External ids             | `externalIds` field and an `identifiers` row set, as Product declares   | The domain writer. Identifier writes own barcode normalization, collision refusal and merge handling, which Product alone needs.                                                              |
| Data-quality checks      | `capabilities.dataQuality`                                              | An evaluator in `generic/data-quality/repo/checks/<entity>.ts`: a check is a domain rule over loaded records.                                                                                 |
| Suggestions              | A field's `control.suggest`, or `capabilities.suggestions` for a family | A family's detector and apply handler. Field suggestions need neither.                                                                                                                        |
| Derived values           | `model.derived`, `model.stored`                                         | Rollups and `via` paths need nothing. `compute` functions and snapshots are domain code; [Background derived data](#background-derived-data) owns them.                                       |
| List and detail sections | `presentation.list`, `presentation.detail`                              | None for `fields`, `relation` and `timeline` sections or `fields`, `records` and `chart` summary cells. A `slot` needs its renderer on each platform, and a `report` cell its server builder. |

A route can declare `nativeRead` when native list reads use a dedicated external catalog instead of
the entity kernel.

## Field resolution and overrides

ADR 0021 defines one typed `fields.<readKey>` envelope for governed and derived fields; ordinary
fields stay simple. Before adding an inherited value or override, trace an existing field through
its stored intent, effective envelope result and provenance, and declared `resolution` actions, and
reuse that contract. Domain rules supply the fallback; the generic framework owns its presentation
and assignment intent. Generic form controls alone do not establish reuse of the resolution
framework. Extend the shared contract when a required state is missing rather than adding a
parallel override path.

A field is complete when its normal reads and supported filters and sorts agree on the effective
value, reset restores inheritance, and source changes update inherited values while preserving
explicit choices.

### Field envelopes

`current` carries authoritative assignment intent and controls; `result` couples the effective
outcome with its matching provenance. Inherit,
explicit value and explicit None are distinct intents. A successful empty outcome is not a missing
computation: a missing result renders Updating…, never the
successful empty state. Who set an own value is not part of the envelope: `fieldAuthority` reads it
from the audit trail when Why this value or the automatic gate asks.

`packages/schemas/src/field-envelope-presentation.ts` and CubbyKit's
`FieldEnvelopePresentation.swift` are the twin owners of empty and missing labels and
assignment-action rules. Surfaces ask them for an absent value's words rather than writing Updating…
or Unavailable; a native read that carried no envelope reads Unavailable through the same owner.
Query loading, mutation progress and list totals keep their own wording.

Current page facts merge selected projections with physical assignment columns before normalizing
reference identities in one set lookup. Physical assignments win; projected references stay
readable current facts without becoming stored intent. Assignment facts load the declared governed
storage columns in a page batch, never treating an effective hydrated value as saved intent.
Editors seed drafts from `current.assignment`; an inherited or cached effective value never becomes
the editing baseline. A cached result carries its deciding provenance and computation time; work
status does not decide whether a usable result exists. Current explanation evidence is not the
historical chain that produced a cached result, and explanations never recompute a live comparison.

One shared Why this value experience owns source stacks, assignment and reset, suggestion review
and explanations on web and Apple ([Field explanations](#field-explanations)). Image stacks use the
same ordered source primitive with view-only thumbnail strips; allocation contributors stay
independent sources. Suggestion previews use the shared suggestion context keys and draft
inheritance policy, which also owns expense line classification for suggestion preparation.
`server/ai/field-suggest/draft-policy.ts` is the single owner of draft inheritance: which entities
resolve a draft (expense, task), their extra preview context keys, whether a create must resolve a
trade, and evidence-backed draft resolution for purchases and financial transactions. A field
suggestion's draft keeps each field's declared inherit mode for every entity; only entities with a
draft policy read it, so other entities' modes have no draft effect until one is declared.

### Overrides, resets and previews

Current own intent wins immediately, with the same precedence as filtering and sorting. Use
inherited removes the override and follows sources; Keep this value creates an explicit assignment.
After reset, show a valid fallback or Updating, never the removed override. Actionable reads carry
current eligibility, exact fallback previews load on demand, and writes revalidate the action.

Reset previews use the field's declared `resolution.resetSource` or inheritance chain and apply its
ordinary reset patch without writing; Expense Project uses the same draft resolver as an edit.
Inherited-field previews run the SQL source ladder with only the local assignment removed, inside
the explanation snapshot, preserving terminal source identity and distinguishing an ancestor's
explicit None from no decision; bounded evidence display never limits the counterfactual. Lists and
saves do not compute previews. A field may declare `resolution.resetSource` when its SQL resolution
can evaluate a typed counterfactual row: explanation reads apply the whole reset patch with
`jsonb_populate_record`, without writing, through the same SQL as ordinary reads, preserving
blocked/empty outcomes. This covers Vendor, Purchase and FinancialTransaction itemization policy and
Expense spending category. Bulk redundant-override reset uses declared redundancy eligibility and the
exact preview; domain-only resolvers without a declared SQL source have no exact preview and are
skipped. Blocked ownership or category evidence stays a successful blocked outcome. Reset rejects a
cached own value or a snapshot with unknown provenance.

Location tree, detail and shortcode reads use the published `valuationRollup` for
`fields.valuation`, batching only the selected ids; reads never compute the population to fill a
missing result, while the background producer and explicit live reports keep live computation.
Inventory reads include the governed Location assignment and compact identity so Move can check
current controls; the joined reference batch supplies its public code.

Physical Product price reads share one SQL value for overrides, cached fallback, price-presence
filters, sorting and footer totals. List filters and totals never walk kit history to manufacture a
fallback before its stored computation completes. UPC enrichment compares authoritative purchase
pricing before writing an override; a missing display publication never makes purchase history
absent. Product Cost is a separate read-only envelope: physical Cost projects the selected valuation
price with its provenance, and service Cost publishes its average, positive-charge count and latest
dated charge atomically. Cost sorting uses that snapshot; valuation-presence filters and Item prices
totals exclude services; date-only Expense edits invalidate the latest-charge evidence. Product
detail exposes `unitPriceMappings` as lists do: the unit-price label and the explanation's
conversion graph (including synthesized effective-price and food/nutrition edges) come from one
shared calculation; raw `unitMappings` alone are not that graph. Services keep their not-applicable
unit-price label. The Project Dates editor is an ordinary saved range; its read-only effective start
projection keeps cache semantics for display and sorting.

### Inherited values

An inherited value has one implementation: the field's `resolution.inherit` declaration
(`entity-definitions/definition.ts`) and its generator, `server/db/computed/effective-field.ts`.
`mode` says when the row's own stored value decides (absent: NULL inherits; a `none` mode value is
an explicit None). `from` lists ordered sources, and the first that decides (a value or explicit
None) ends the chain: `"hierarchy"` is the nearest live ancestor along `model.hierarchy` whose own
value decides (cycle-guarded, capped at `maxDepth`); `{ hierarchy: { whileSame } }` stops at the
first ancestor whose effective `whileSame` field differs from the row's; `{ path }` reads the
effective value of the field a to-one path ends at. A path may declare `when: { field, value }` to
admit only related records of a required kind (a credit card inherits its member ledger party as
primary cardholder). Lazy field evidence uses the field's `explanation.evidence` strategy for
specialist contributions and walks `resolution.inherit` directly for hierarchies and paths.

Project assignee, locations and default trade, product category feature, spending mapping and stock
tracking, and task project, subject product and assignee walk their hierarchy; the task assignee
then falls back to its effective project's default, and a Product's stock tracking reads its
category's (ADR 0013). Task trade walks only ancestors on the task's effective project
(`whileSame: "projectId"`), then reads that project's default trade.

`effectiveFieldSql` is the value every read, list row, filter, sort and group uses;
`inheritedFieldSql` the fallback; `effectiveSourceSql` and `inheritedSourceSql` the record that
decided the value or fallback; `inheritanceLadderSql` every record a hierarchy chain reads, ending at
the ancestor a `whileSame` walk stops at (`eligible` false). A stored filter over an inherited
field, a `via` path ending at one, and a relation edge whose foreign key is one all read the
effective value; a batched traversal toward the source may join a statement-local relation of each
row's effective value. An unconditional hierarchy-only chain filters in the top-down set form
(`effectiveFieldInSql`), resolved once per query. Repositories format provenance labels and nothing
else: never hand-write an ancestor walk or fallback for a declared field.

Same-record `not_allowed` classification policies gate effective values and suppress table and
detail editing and suggestions on web and Apple. Render a quiet dash with an accessible
explanation; never label an inapplicable field as unassessed. Server-resolved allocated values stay
visible with their evidence when manual assignment is refused, but expose no editor, suggestion,
reset or clipboard write. Applicable empty values keep normal controls. Classifier read dependencies
travel with the field; policy evaluation reads a public classifier through its envelope, while
stored rows and drafts use their explicit key before projecting the remaining classifier path.

These fields keep their own resolution because their rule is not inheritance or needs more than a
small step kind:

- Expense `projectId` and `trade`: only principal lines resolve (other lines read no project, or
  their own trade); a Purchase's default project counts only when that Project is live (its default
  trade needs only a live Purchase); a food line's last fallback is a classification policy, the
  designated household Project chosen by shortcode when the Product's category feature is food. The
  allocation join form (`principalExpenseInheritanceSql`) must equal the scalar one, which checks
  uncorrelated live-Project id sets (live explicit Project → live Purchase default → household food
  fallback). Drafts without Project, Product or Purchase references resolve without a database
  read; referenced drafts keep live resolution.
- Expense `spendingCategoryId`: a ladder of override, vendor food context, category mapping,
  purchase and vendor defaults whose category step reads draft values projected into the walk for
  review previews.
- Inventory `ownerLedgerPartyId`: resolved in TypeScript from acquisition evidence.
- Product `price`: a derived kit or expense price, not inherited.
- Recipe `servings`: derived from the record's own yield when measured in servings
  (`resolveRecipeServingValue`).
- Purchase and FinancialTransaction `itemizationExpectation`: a policy ladder across vendor and
  category.

Project subtree expansion has two forms: a caller needing only ids reads `loadProjectSubtreeIds`
(`hierarchyDescendantsSql`, the list filter's expansion); a caller that already loaded the tree
walks it with `collectDescendantIds`; project tree pages walk their filtered children map. A
set-valued fallback is outside `resolution.inherit`: Purchase `paymentAccounts` stores only
explicit `purchasePaymentAccount` links and otherwise derives its accounts from payment evidence
(`purchasePayingAccountIdsSql`).

### Nested references and embedded edges

Nested references carry only what their consumer needs. Recipe usage rows and `appearsInRecipes`
carry recipe identity (`id`, `name`); amounts, modifiers and original-line evidence stay on the
usage. A nested record that exposes governed values uses a named typed envelope projection.
Ingredient product rows keep their nutrition, food, mapping and price content.

Declare these edges in `fields.embedded` with the nested property path, target entity and
participating projections. Generation reads array, nullable, lazy and tagged-union structure from
the schemas and emits concrete child schemas and serializer traversal; section-line subrecipes stop
at scalar snapshots. Direct self edges may declare `recursive: true` on detail projections, which
emits a typed lazy node (Location detail and tree reads share it). Root-only attachment metadata
stays on the root. Traversal follows only supplied, bounded topology and batches current facts
across levels; frozen provenance references stay outside it. Explicit embedded paths can name a
governed container such as Location's installed Product. Compact identity leaves validate without
fabricated fields. Web reference readers normalize expanded records and scalar ids once; expanded
targets keep their identity, label and emoji, and explicit empty results never fall back to a
nested target.

Live Image leaves are marked in their owning schemas and require explicit `fields.embedded` edges;
generation rejects an undeclared leaf, and embedded parents inherit their target's Image edges.
Image attachments use a bounded generated Image projection, so they cannot recursively attach
themselves. Specialist responses collect declared entity nodes into one heterogeneous batch,
deduplicating fact loads by entity and identity while keeping each node's projection, order and
duplicates. Frozen review proposals and provenance evidence are not live nodes. Child schemas import
target field-schema leaves rather than full parent reads.

A field may declare `validation.publicRead` when repository inputs contain facts that must not
become competing public values; generated projections apply it to existing keys on root and
embedded records and never add a key. Repository/compiler `Raw*` read schemas keep internal resolver
evidence outside the field roster; public manifests never publish a `fieldResolutions` descriptor.
Private work and settlement composition imports named raw read modules; public façade exports and
specialist containers use canonical envelopes. Public entity and specialist `*Out` exports expose
the canonical envelope, including nested Ingredient and Inventory products and Recipe section
snapshots. Serialization deduplicates fact loads while preserving each snapshot; missing current
facts fail the read instead of inventing ownership.

Specific consumers:

- Unit-price quotes and their explanation graph compute at read time from the selected valuation and
  current conversion facts; they do not claim that valuation's provenance or computation time.
- Cross-entity `entity.records` and Work Queue digests keep compact cover display snapshots that
  provide no alternate assignment or control facts.
- Inventory holding Locations expose name and governed type only. Inventory embedded in Product reads
  and photo candidate evidence exposes the same amount and valuation envelopes. Inventory mutations
  use their envelopes on MCP too; there is no slim Inventory adapter.
- Meal occurrences keep their scale and evidence beside canonical Recipe servings and totals.
  Nutrition reports reuse one selected Meal classification envelope; Product nutrition inputs select
  only identity, pricing, unit mappings, label nutrition and food-lookup identifiers, skipping
  unrelated detail bindings.
- Photo-review Product evidence uses canonical tag and brand fields beside retained photos,
  identifiers and purchase-line evidence; observations cannot authorize edits or automatic
  ownership. Duplicate stock results carry the selected Product brand envelope. Discard-preview
  amounts stay evidence for their one command calculation.
- Location inventory-count trees expose only identity, topology and counts.
- Cookbook retitles return the kernel mutation receipt; list reads own the summary and counts.
- Native manifest paths unwrap the same result before walking nested values; a missing or empty
  outcome never falls back to a plain value. List rows carry envelopes, without a derived sidecar.
  Generic merge responses pass the keeper through the same serializer after the write.
- Vendor logo and coverage reads use the canonical projection (`fields.latestPurchaseDate`).
- External USDA records stay ordinary source facts; their linked Products use canonical outputs,
  serialized once per food page while keeping duplicate and empty linkage groups. MCP reduces them to
  identity references, and MCP Recipe usage responses carry identity and line evidence only.
- Image repositories keep raw hydration inputs; direct Image replies use canonical projections. Live
  attachments and photo-match galleries use bounded Image envelopes; compact display-image entries
  are value snapshots. Hash repair exposes `originalUrl` as an original-byte locator; upload and
  storage receipts are ordinary asset references.
- Meal recipe mutation replies keep the canonical Meal list projection in MCP; plan receipts stay
  command-specific. The Project tree operation and Project promotion from Tasks serialize through
  the batched list projection; client nesting changes presentation only.

## One declaration, several consumers

Each declaration co-locates schemas and field policy. Use an existing ordinary declaration as the
working example and `definition.ts` for accepted metadata; the compiler enforces the exact keys, and
a prose copy of the full shape would drift. Source references name a module and export; they never
import implementations into the declaration. `fields.detail` is optional and falls back to
`fields.output`; declare it when the detail read carries enriched relations or computed fields.

### Presentation metadata

`presentation` is everything a generic surface needs to present the entity and nothing a surface
computes. `titleField` must be a read-projection key resolving to a **non-nullable** text field. An
entity whose natural title can be empty declares a storage-less read-only `displayName` field
(`validation: { read: z.string(), create: null, update: null }`, absent from `storage` and every
`intents.fields` roster), computed in the repo mapper, and points `titleField` at it (Planting,
Meal, Purchase and Inventory do). Presentation also carries `domain` (one of the ordered
`WAYFINDING_DOMAINS`: Plan, Cook, Pantry, Garden, House, Purchases, Finance, or `null`),
`description`, `emptyState` copy and icon names (`phosphor` is checked against the browser icon
map; `sfSymbol` reaches native verbatim). The generator emits it in `entitySummary`
(`generated/entity-summary.gen.ts`, data only, safe for eager client code), spreads it into the
inspector, and writes `domain`/`sfSymbol`/`emptyState` onto the Swift `EntityDescriptor`, so web and
native empty lists print the same copy and create label. Identity marks and empty states read this
metadata. Plants, Plantings and GardenEntries belong to Garden; Purchases, Shipments, Emails, Vendors
and VendorAccounts belong to Purchases.

`nativeBrowse` (default `true`) declares whether the root appears in native Browse and the native
sidebar (`EntityCatalog.browsable`). Set it to `false` only for operator plumbing whose list serves
no member task on a phone or Mac (Jobs, Image jobs, source transaction records, transaction
imports), with the reason beside the flag; records still open natively from links, and web
navigation ignores it. The summary also carries the resolved `primarySearch` (declared, else
`searchQuery` for a searchable entity) and the `bulkUpdate` roster, from the same helpers the
inspector uses (`generator/entities/render/shared.ts`). `packages/schemas/src/sidebar-manifest.ts`
owns `SIDEBAR_SECTIONS`, the single ordered navigation roster for desktop web, the mobile More sheet
and generated Swift `SidebarManifest.sections`: each section declares id, label (empty for top),
nullable domain, default fold state and ordered destinations (nav label, web route, and a
browser-routed entity or specialist SF Symbol). Page titles keep their full names.

`presentation.detail`, `.list` and `.edit` are the one declaration web and native renderers draw
from. A differing value replaces a default the compiler computes; additive or required
declarations (`detail.sections`, `list.views`, `list.totals`, `route.list`, `route.detail`) take a
plain name. The generator compiles each override without it and refuses one that changes nothing,
so the Schema tab's override table lists only live deviations.

A record's mark is, in order: its emoji (`presentation.recordEmojiField`), its display image (own
or borrowed), its `recordGlyph` option glyph, then its icon. A set emoji replaces any image in list
image cells, reference pills, detail headers and native thumbnails; a record's own gallery stays in
the detail hero. Web list reads request the emoji and glyph fields with every row, and the name
cell does not repeat a mark the image cell draws. `presentation.recordGlyph: { field, options }`
reads `field` and draws the glyph that the `options` enum field declares for that value (a Product
Category's effective family). Aggregate buckets keyed by a marked record's shortcode (analytics rows
and columns, Sankey nodes, cash-flow baselines and envelopes) carry that record's `emoji`, read in
one batch per axis; other buckets carry null.

`presentation.recordIconEntityField` names a read-only projection holding an entity key. Generic web
and Apple record surfaces resolve that entity's declared icon, falling back to the record's own
icon for missing or unknown keys; record emoji and real media keep precedence, and navigation keeps
the entity's type icon. Runs project `iconEntity` on entity and Activity reads: the subject's entity
wins, AI work can use its ledger party, otherwise the purpose selects the entity concerned. Status
and execution device never change identity. The projection is not stored.

A select option's `description` is the tooltip of its pill wherever the value renders. A `number`
field whose provenance is `derived` from one `{ entity, relation }` source links to that target's
list, filtered by the entity's relation section for that relation, in its list cell and as the
detail fact's filter action. A governed field displays its envelope result with matching
provenance.

### Detail sections

`detail.sections` is required on every entity and lists the detail page's sections in reading order
under readable ids:

- `fields`: a named subset of `display.detail` fields. Every such field is placed exactly once — in
  a section, a `fields` summary slot or a relation's context fields — unless it is `listHidden`; the
  generator fails on an unplaced field.
- `relation`: the target's list filtered by an id/idMulti descriptor whose `brandRef` points back
  here, with optional `columns`/`sort`/`limit`.
- `timeline`: the entity's timeline capability.
- `slot`: the one per-platform hand-written fill, rendered only where a registry provides it
  (`DetailSlotId<E>` / `ListSlotId<E>` in `entity-manifest.ts` type those registries).

Sections are authored for reading; nothing derives from edit groups. A section keeps its declared
`workspace` (`overview`, `work` or `evidence`); otherwise relations join Work, timelines Evidence and
other sections Overview. On full web detail, sections that set `overview: false` join Evidence
unless they choose another group; `detail.overviewSections` still emits independent `overview`
metadata for web and Swift. Web renders sections in declaration order after any `detail.lead`
sections, full width unless `detail.pairs` sets two side by side; pairs stack below 1000px of
workspace, relation tables cannot pair, and there is no supporting rail. Native ignores `lead` and
`pairs` (`detailSectionJSON` omits them), and a board list view marked `webOnly` is omitted from
Swift. A section's `placement` is `primary` (shares a ruled plane) or `full` (its own plane);
journal presentations keep relation-first ordering. A quality check's `placement: "images"` shows
its result in Images. Web identity and media composition follow
[the web design contract](../apps/web/DESIGN.md); galleries remain their own section.

Relation sections may declare a web `createLabel` for the scoped create action; the compiled seed
still owns the prefilled reference. Location leads with its direct Child locations table, kept when
empty, offering Add child location with the parent prefilled. Lead relation tables and the first
remaining relation stream immediately; later relations wait for counts, keeping fragment
destinations mounted. A loaded relation's heading carries its total (`Photos · 12`) from the first
page's `meta.totalCount`; at zero the section collapses to one quiet row with the declared `empty`
copy or `Title · 0`, and its create action stays reachable. Visibility and folding flags are absent
from declarations and catalogs; pagination and show-more behavior are declaration-owned.

Every generic detail includes the Connected records section ahead of Relationships, including an
empty section when no local routes exist. It reads one `entity.connectedRecordsPreview`: every
local-path logical relationship and its inverse, including same-type relationships, plus curated
multi-step routes, grouped by target kind with target records deduplicated and every witnessed
explanation kept; curated route keys stay addressable aliases. Every group and body renders
continuously; navigation scrolls to stable sections and preserves mounted drafts. Headings and index
entries stay present while loading and after a section empties. Old group fragments remain jump
aliases; a real section id wins over a matching alias. Explicit jumps add history; scrolling only
moves the highlight. Photo comparison grids respond to their own width. Apple keeps native record
fields and Contents navigation (following the native reading order, all bodies visible) and hosts
Connections in the shared workspace; the Run evidence pilot renders only the shared Evidence group
in its isolated hosted surface. Durable transcripts and structured logs stay available for every
Run purpose; purchase-import predicates apply only to workflow reports. Workspace vocabulary is
presentation metadata, separate from SQL enums.

Relation tables are opt-out: every `many` relation renders a table, either a declared `relation`
section or one the compiler derives (`generator/entities/derive.ts`, `derived: true`, the target's
default columns). Empty derived sections stay visible and open. The derived section uses the only
id/idMulti descriptor on the target whose `brandRef` names this entity and that no other section on
the page uses, or among several the one over the relation's own FK column; a self-relation (a
product's kits vs. components) matches only by FK column. When nothing resolves, generation fails
until the relation gets a section or `detail.omitRelations: { <relation>: "<reason>" }`; a target
with no list page is recorded there automatically. `entity-relation-coverage.unit.test.ts` holds the
coverage invariant.

Inverse relations are opt-out too. A `one` relation over a single outgoing FK (`Planting.taskId`)
gives its target a derived `many` inverse (`task.plantings`) unless the target declares one over the
same path or the relation sets `inverseOmit: "<reason>"`. A `many` relation over a single incoming FK
gets a stored `idMulti` back-filter on its target when none names this entity. Every idMulti filter
declares a `brandRef`, so URL values stay shortcode-native and related-view filters work as
back-filters. Curated related list views belong on their relation's `.named` options as `view`;
source, target, label and path are inferred; `key` overrides only the persisted view suffix and
`filterPrefix` only the filter prefix. Rows default to alphabetical order; preview columns follow
relation declaration order. A preview's "View all" opens the target list filtered to the row, through
the same target filter the source's detail relation table uses; a relation without one opens
Connections. The generator emits the literal related-view registry and per-entity
id, presence and search schemas; LedgerParty filters keep `@me`; `filter: false` keeps a
presentation-only view. Explicit `inverseKey` values must name reciprocal views with matching
endpoints.

A relation section's create button seeds the descriptor's field on the new record: the descriptor
key when it is a create field there, otherwise the one target reference field whose
`reference.entity` equals the descriptor's `brandRef.entity`. When several fields could carry that
identity, or the writable field is a multiple reference, the section declares `prefill: { field }`,
which the compiler checks is writable on create and references the owner. Web and native consume
the generated prefill. `history`, `relationships` and `images` derive from capabilities and are
never declared.

### Detail summary

`presentation.detail.summary` owns the ordered header cells for every entity. The generic header
renders up to eight applicable cells beneath the identity and actions; it adds no Overview section.
The first four are the record's glance, which each client's DESIGN.md lays out first, so order them
to answer the record's main question. A field a `fields` slot shows is omitted from later field
sections and relation context fields on both clients; on web the cell carries the field's renderer
or inline editor. A one-field cell with no value is omitted and its field stays in field sections.
Keep workflow-form renderers (FinancialTransaction allocations' booking review) out of the web
summary with `surfaces: ["native"]`. Summary cells drop absent fields and readers that find nothing.

Summary slots and detail sections accept `surfaces: ["web"]` or `["native"]`; omitted, both render.
Native generation drops the other surface's entries and web filters at render, so one declaration
keeps one order. Entries have stable `id` and `title` and one of four kinds:

- `fields` groups one to four readable field keys with the record's effective values and renderers.
- `records` names a declared connected view or `relation:<key>`, showing bounded linked targets (two
  on web), the complete count and witnessed paths. Web cells always show a count/link when
  populated; a relation with a matching web section links to that section's id (from an inspector it
  opens the full record there), others to Connections. Empty lead relations keep their count/link;
  unknown or failed reads never claim an empty count.
- `report` names an existing report owner for concise figures, records, progress or charts.
  Workflow forms and commands stay in their owning section.
- `chart` names an Expense-ending connection view and draws the canonical monthly-spend series; it
  consumes one of the eight slots.

Do not maintain per-entity header maps, a second chart registry or client arithmetic. Empty optional
relationships may disappear; meaningful unknown values, pending reads and failed reads stay
distinct. Preserve declaration order rather than ranking cells.

Every `chart` path must end at Expense. `entity.monthlyExpenseSpend` returns the current household
calendar month and eleven predecessors, oldest first, zero-filled; it sums distinct live actual
Expense costs (credits included), rounds to cents after summing, and excludes planned lines.
Location charts describe stored products' expense history, not expenses incurred there. Product
seller rankings count distinct actual Purchases containing the Product through its Expense evidence,
keeping purchase count and last-purchased date. Product purchase-project context follows its own
Expenses to their Projects; a sibling item on the same order cannot supply its purpose. A Brand
reference names the marketed Brand, never an inferred manufacturer.

`detail.activityRelations: [{ relation, dateField }]` opts traversable many relations into
`entity.detailActivity`. The date must be a stored date or timestamp on the target; undated records
are absent. Source-record audits join the selected records before sorting and cursor pagination; the
entity filter applies to record and change events; record ids deduplicate paths; only Expense events
carry `amountCents`. Cursors keep database timestamp precision with the event id as tie-break.
Data-only web consumers use `useDetailActivity`
(`entity/entity-detail/use-detail-data.ts`) and the `entity.monthlyExpenseSpend` query.

### Actions and merge preview

`detail.hero` names the chip (an enum or boolean field), stat fields, a breadcrumb field, and `when`
(a date or timestamp, optional `label`) shown through its renderer ahead of the ingest `createdAt`,
which it replaces as the leading time and falls back to when empty. Hero images follow the gallery
capability. The breadcrumb is a reference or a placement (`{ locationId }`); the detail read projects
it as `breadcrumb: [{ entity, id, name }]`, outermost first (a location yields itself and its
ancestors, another reference the one record, Product its primary placement's path). Web trails it
before the record code; native captions the hero with it
([Continuous record detail](../apps/apple/DESIGN.md#continuous-record-detail)).

Actions derive from capabilities: the hero gets `edit` with an update contract and `delete` for a
mutable entity with kernel-owned deletion; shared and extra hero actions are deduplicated. Web
always offers Copy code. Merge stays a list/selection workflow. A list gets `bulkEdit`, `merge` and
`delete`. `hero.extraActions` and `list.extraActions` add workflow verbs (list extras precede derived
actions); `detail.quickActions` and `list.quickActions` promote one or two declared verbs
(generation fails on others) and remove them from More. `entity.detail` and every `entity.list` row
carry `actions: [{ id, enabled, reason }]` for the union of hero and list verbs, evaluated in
`server/generic/actions/entity-action-states.ts` from the per-verb rules in
`@cubby/schemas/action-availability` (`requires` a present value, or `unlessValue` for a preset
write the record already holds). A page costs no extra query; a narrow `fields` read adds the rule
fields. Clients render `enabled`/`reason` and derive no availability.

`entity.mergePreview` returns the kernel merge's suggested survivor (most live incoming connections,
then oldest, then lowest code), every scalar update field the candidates disagree on, each
candidate's incoming connections with their `entity.connections` disposition, and `blockers` for
merging into the optional `keepId` (live `block` dispositions plus the merge port's own rules:
Product editions, kit cycles, classification). Keeping a loser's value is the merge's
`survivorValues` (`{ field: value }`): each key must be a reported conflict and each value one a
candidate holds, checked before the merge; the kernel applies them to the survivor after the merge
in the same transaction, so a refused merge leaves the survivor unchanged and a merged-away value
cannot collide with its own live unique key. The kernel `merge` verb is in `entity-kernel.json`
wherever merge is kernel-owned, so native dispatches the same `entity.mutate` merge as web.

Web record-level slot actions render once in the detail header through `DetailActionTarget`
(`entity/entity-detail/detail-action-bar.tsx`). `reportDetailActions` identifies record-level report
commands and diagnostic rows, leaving approvals, selections, recipe scales, per-row imports, guided
regeneration, ownership confirmations and other contextual work beside its evidence. Finance verbs
with `scope: "section"` use the header; `scope: "selection"` verbs stay with checked rows and their
disabled reasons. Stored URLs, source mail links, map coordinates and linked identifier values are
facts, not header actions.

### Native action placement

These knobs are presentation facts; server reads own availability, figures and totals. Every
browsable entity declares what applies to it.

- `list.rail`: at most two list-readable number, money, amount, date or server-worded (`labelPath`)
  fields, each with an optional `sub`, not repeated as row facts. `total: "sum"` joins the grouped
  metric roster, so additivity rules apply (money must be Expense-derived).
- Option `quiet: true` marks the expected value rows leave unsaid (a task's Not started), one per
  roster, on the control roster (`withQuiet`), not filter presets. Option `closed: true` marks a
  terminal value (Done): a record holding it is finished, so a passed deadline is not overdue.
- `capabilities.mergeFlow: "specialized"` declares that web merges through its own flow instead of
  the generic merge dialog; native's selection Merge then hands off to web. It requires `merge`.
- `list.rowCommand` draws one `list.extraActions` verb as the row's leading control. `list.swipe`
  replaces the derived swipe verbs, or `false` removes them.
- `detail.quickActions` (filled) and `detail.quickFields` (tonal, updatable fields that open their
  inline editor) share four action-bar tiles. `detail.heroMedia` is `tile` (default) or `banner`.
  `display.inlineEdit: false` keeps a simple field out of tap-to-edit.
- Thumbnails borrow through `capabilities.images.displaySources` (an Expense shows its Product,
  then its Purchase, then that Purchase's Vendor).

CubbyKit `ActionPlacement` is the one native derivation of where actions appear. Leading swipe:
list quick actions, then one-tap non-destructive verbs, at most two. Trailing swipe: Delete,
destructive verbs, More. Context menu: verbs and flows, Edit and Select, Copy link / Share / Open on
web, destructive last. The selection bar holds Bulk edit, Merge (two or more), verbs whose native
plan sets `bulk`, and Delete. Detail tiles come from quick actions, then one-tap verbs, native flows
and quick fields, never destructive. Detail More groups verbs, create (flows, Add photo), share, web
handoffs and destructive actions. Unavailable actions are hidden in swipes and context menus and
dimmed with their reason elsewhere. Availability is the row's server `actions`; without it,
placement falls back to the plan's `requires`.

`native-coverage.ts` owns native execution. A `flow` plan presents a screen the app already owns
(`NATIVE_FLOWS`: receiving an Expense, the location photo pass). `nativeRecordActionPlans` adds record
affordances that are not web verbs: a flow, or a handoff to a declared detail section, limited by
`when` record conditions. Expense `receive` is a declared verb on both clients.

An `implemented` hero action needs a plan in `nativeHeroActionPlans` (emitted as `heroActionPlan`):
the verb maps to one generated operation, an input form and a confirmation (`destructive` for delete
and discard). A `setField` plan with a `value` writes that option on one tap; `editField` asks for one
updatable field seeded from the record. `HeroActionRunner` executes every plan, and `pnpm generate`
fails when the operation is not on the generated client or the body names an undeclared field. A
server `*Preview` query supplies any "what will this do" text (`product.discardPreview`,
`entity.connections` for delete), so both clients show the same verdict. A list/multi-select verb
(`bulkEdit`) is `ownedElsewhere`, not a plan.

### Native coverage and structured values

Which presentation ids the Apple app does not draw is declared once in
`packages/schemas/src/native-coverage.ts`: every control, list and detail renderer id, hero action
and entity-qualified detail and list slot has a status (`implemented`, `generic`, `ownedElsewhere`
or `handoff`). A `handoff` is a reviewed web-only surface with `web: { section?, query?, label }` and
a `reason`: native draws one row that opens the record at the declared `section` (the web hash) or
the list route with `query`. Records are typed against the generated id unions;
`native-coverage.unit.test.ts` fails on an unclassified id and pins the handoff roster. `pnpm
generate` writes `native-coverage.json` into the CubbyKit bundle for `NativePresentationCoverage` and
refuses a detail-slot handoff to an undeclared section; the schema page lists each entity's handoffs.
To move a surface to web, classify it `handoff` in review; to bring it native, build the view and
flip the status. Named renderers are classified by this owner during compilation; whole-row
renderers declare their minimum consumed inputs beside that disposition. Compiler schema checks do
not prove executable web or native registration.

A field whose control renderer is in `STRUCTURED_VALUE_RENDERERS` (`external-ids`,
`label-nutrition`, `source-aliases`, `source-refs`, `unit-mappings`), or a `structured-field` listed
in `nativeCoverage.structuredField`, is an object or array of objects edited by one generic editor
per client over the same generated description. Every `structuredField` entry is a `handoff`: native
shows its read-only summary and opens the declared web section, so only the listed renderers edit
natively, through CubbyKit's `StructuredValueControl` and web's `StructuredValueField`
(`entity/editing/structured-value-field.tsx`). A field joins only with a read-to-input vector in
`packages/shared/golden-vectors/structured-roundtrip.json` that web parses with the input schema
and that `StructuredValue.swift` and `structured-value.ts` both project. `structured-field` vectors
are generated by `structured-field-vectors.integration.test.ts` (and
`recipe-sections-vector.integration.test.ts`), which write a synthetic record through the server and
fail unless the stabilized read equals the vector's `read` and the editor projection its `input`.
Where a read nests what the input names flat, the input field declares `.meta({ readFrom:
"ingredient.id" })`, emitted as the field's `readPath` for `StructuredValue.project` and
`structured-value.ts`.

`pnpm generate` derives the `valueSchema` from the field's Zod input schema (`update`, else
`create`; `generator/entities/render/value-schema.ts`) and writes it to the Swift manifest and
`generated/structured-value-schemas.gen.ts` (imported only by the editor): nullable text, number,
boolean, enum, shortcode reference, amount (`{value, unit}`), constants, objects, arrays, maps over
an enum of keys, and variants over a literal key. `.meta({ opaque: true })` marks a key carried
untouched and never shown; `.meta({ title })` owns a property's label on both clients (absent:
humanized key); unit-mapping operands keep stored keys `a` and `b` while reading From and Equivalent
to. A variant starts with no case chosen, so a new account must pick its identity kind. Validation
stays server-side: issues land at `GenericEntityEditModel.nestedError(key, path:)` on native and the
nested form path on web. A new structured field needs only its Zod input schema, a renderer in that
list or a `structuredField` entry, and a vector. `.meta({ createOnly: true })` locks a value on edit
(the server refuses a change too); `.meta({ notice })` shows a caution with it.

A source claim is edited under the identity its read exposes: the read carries `sourceKey` (a hash
of the provider id or the evidence, so the provider id is unrecoverable) and the input accepts it
(`ledgerSourceClaimInput.sourceKey`, exclusive with `providerId`). `resolveClaimKeys` refuses a key
the record does not hold and a request resolving two claims to one identity. A provider-keyed claim
keeps its key across evidence edits; an evidence-keyed claim is re-hashed in the same replacement.
A kept key keeps its stored `sourceKeyVersion`.

The descriptor wire shape is declared once in `packages/schemas/src/manifest-wire.ts`. Synthesized
Codable owns encoding; the catalog stays bundled JSON to avoid the Release compiler stall from a
giant Swift literal.

### Reports

A `slot` whose content is figures, a chart series, a table or dated schedule rows has no
per-platform code: the server composes it once (`entityReport.get`, builders in
`server/generic/entity-report/repo/`, block kinds in `packages/schemas/src/entity-report.ts`) and
web (`ReportBlocks`) and native (`ReportDetailSlot`, Swift Charts) only draw it. `entityReport.get`
takes an explicit `record`, filtered `list` or bounded `selection` scope in a POST body; each builder
validates its entity, filters and cursor, and unsupported scopes fail rather than falling through.
Records reports can supply relative workspace `links` (Vendor and Vendor Account Mail coverage).
Portfolio analytics reuse the domain allocation query; task briefings reuse the ranked Today
projection. Add the slot id to `reportSlots`, a builder, and the declaration or collection surface.
Money in a report is `SUM(Expense.cost)` or the persisted valuation, never client arithmetic, and
summaries and chart labels keep cents. Linked record names truncate so trailing amounts stay visible
on phones. When an indexed section supplies a block's heading, the nested renderer omits it.

Entity reports declare lazy dependencies in `server/generic/entity-report/repo/`; each batch
memoizes them by declaration identity, keeping slot order, duplicates, cursors and status. Reuse ends
with the batch; there is no cross-request cache or encompassing transaction. Member-gated histories
resolve viewer membership before record identity.

The finance slots (purchase reconciliation, project allocation and financial settlement, expense
settlement, statement-charge search) use the `records` block: rows a person opens or checks plus
the verbs that act on them (`SECTION_ACTION_IDS`). Each row's and verb's `disabledReason`, every
amount and the footer are the server's. A verb a client lacks is classified under `sectionAction`
in `native-coverage.ts`: native runs only Receive into Inventory and hands statement match, split,
attaches, reconciliation, expense settlement and spending classification to web. Split and attach
rules stay on the server: `purchase.splitStart` and `purchase.checkSplit` (whole cents adding up
exactly, one product part, an attribution choice and the body), `purchase.linkExpenseCandidates`
and `purchase.checkLinkExpenses` (including the confirmation when expenses move off another
purchase), `purchase.linkProductCandidates`. The write re-validates; a refused check sends no write.

A `records` row may carry `badges`, `lines` (an untoned line is the result, `muted` lines its
evidence, an optional `ref` opens context), a `trailing` figure, an `externalLink` (label and HTTP(S)
URL), a collapsible `detail` and `commands`. A command names an existing mutation operation and its
exact body. The mutation contract's opt-in `command` metadata owns shared operands, confirmation and
result presentation; `operationCommandRequest` checks server construction against the operation
input, and generated web/native dispatch invokes the same operation and cache policy. Both clients
confirm before sending when copy is declared. Form bindings replace only declared operands; frozen
evidence, fingerprints and approval bodies stay in the request and the writer validates them again.
Cookbook chunk loops and interactive device/review adapters keep their domain protocols. Commands
add no workflow executor or business-rule language. A report may say the record is `live` (clients
poll; no realtime transport), carry its `status` (a client showing another refreshes the record) and
a `nextCursor`. A page showing several slots of one record polls one `entityReport.getMany`.

A `records` row may also carry a `choice` and the block a `form` (choices, progress wording, a
`disabledReason` and the one command the answers unlock). The server words every label, ranks
`suggestions`, says what is `required` and never preselects an answer: identity is chosen by the
person. An option may ask for a pick, a reason or a Distinct-from Source (`url` and `quote`);
"Create a new Product" lists the exact-name and identity-review candidates the commit guard would
refuse. Clients check completeness with the shared rules (`packages/schemas/src/report-choice.ts`,
mirrored by CubbyKit's `ReportChoiceAnswers`) and send the body the answers assemble
(`commitPreparedInput`) with a fresh operation id per answer change. `run.import-prepared-orders`
uses it.

Run import report eligibility comes from each Run kind's `importReport` flag in `RUN_KINDS`, derived
as `IMPORT_REPORT_RUN_PURPOSES` (including `mail_import`); web and server use its predicate and Swift its generated constant. This is
presentation, not execution authority; discovery and the Imports saved view have deliberately
different scopes. A photo batch keeps its own review and transcript.

The storage-only `getRunWorkProgress` projection supplies both `run_read.work_snapshot.workProgress`
and the Run's `progress` block. Every Run purpose declares a count source; exploratory populations
have `total: null`, never zero. Producers fill `runWorkItems`, where `processed` is an absolute
completed count including failures and skips, and persist samples through `sampleRunWork`; use a
new phase or unit, or reset, for a restarted population. A Run in an ended status (`needs_review`,
`completed`, `failed`, `dispatch_failed`) reads its last phase finished, never paused, whatever its
ender last recorded. ETA needs a known total and at least three
intervals; stale or paused estimates name the reused rate and last progress time. A Mail import Run
also reads `outcomeCounts`, each admitted Email counted once by its newest outcome in that Run, and
every Run reads `chargedUnpricedCount`, its calls without a charged price. Later phases never
take an overall ETA from the current phase, timeline event frequency is not throughput, and
generation charges and label suggestions never share a percentage. Web and Apple draw the same
server-composed summary.

### Expense analytical reads

Expense analytical reads use `server/domains/expense/repo/expense-derived-read.ts`: a declared scope
and SQL projection batch share one materialized allocation relation, consumed by compatible charts,
analyzer grids and facets in one statement (distinct date scopes stay separate). Ledger selection,
search, related views, contributions and project rollups use the same owner rather than correlated
per-row allocation. Selection limits purchases to resolve while every live principal sibling
supplies the denominator. Stored Expense list predicates narrow the selection before allocation;
quality and caller-supplied derived conditions stay outside; reads without stored constraints keep
the whole-ledger path. Trade and cost-type scopes do not resolve spending categories unless needed;
trade inheritance follows the canonical Project policy even when Project output is omitted.
Membership projects Expense ids without aggregating costs. Prepared selections stay SQL relations:
analytical callers use `expenseSelectionForWhere`; batch contexts accept relational selections or
literal ids, never `ARRAY(SELECT ...)`, which hides cardinality and repeats allocation scans. Scope
filters apply to rounded shares, unknown costs stay null, and unscoped totals sum original costs.
Unclassified receipt roles keep one unresolved allocation with the original signed amount and never
enter adjustment weighting; role completeness is reported separately from amount completeness.

The full-filter Product price footer groups live sibling quantities and visited kit-ancestor
Expenses; page-sized scalar pricing keeps its correlated path. Preserve values, signed money and full
sibling weights when revisiting either path, and measure broad and one-leaf populations separately.

### Derived relationships and Emails sections

A relationship whose provenance is `derived` is inferred from stored evidence rather than one FK
path and stores nothing (ADR 0011). It names the target's list filter that answers "records related
to this one"; relation sections, HTTP, MCP and native read it through that filter, and the graph
walker, delete policy and FK manifest test skip it. Purchase, Vendor and Vendor Account declare
`emails` this way, and Ledger Party declares `purchases` over Purchase's effective `purchaserId`.

**Emails sections.** Purchase, Vendor and Vendor Account detail embed the Email list scoped by its
`purchaseId`, `vendorId` or `vendorAccountId` filter, one row per Email. Each row carries
`purchaseLinks` (every related Purchase in scope with its state) and the scope-relative
`linkState`: accepted import sources and reviewed links are Linked, then live suggestions (an exact
order id, or a matching total within 45 household days when either side lacks an order id — never a
nearby date alone), then Dismissed; a Vendor's sender-proof mail with no Purchase reads "No Purchase
match". An undecided current order event whose order id names exactly one live Purchase on the
owner's account links automatically (`linkExactOrderEmails`: proposer `heuristic`, authority
`automatic`, producer rule `EXACT_ORDER_LINK_REVISION`) and appears in automatic decision history,
whose "Dismiss link" correction records a member dismissal it never overrides. Any active decision on
the event, a member dismissal of that Purchase on another of the Email's events, an accepted import
source, a second equal-order Purchase on any account, or an amount match keeps the pair a
suggestion. Purchase create, order id or Vendor edits and import writes link inline; the hourly pass
catches up the rest.

The section sorts by link state, newest first; a single included link-state filter fixes the rank,
so ordering reuses that constant with date and stable ties. Inside a Purchase's section the row menu's
Link and Dismiss review the pair; only the Email's owner (`ownedByViewer`) may, and an
import-accepted source cannot be dismissed. A Link replacing another Purchase's link on the same
order events asks first. Each decision keeps its proposer (member, agent, import or the heuristic);
the Emails Accuracy view counts dismissed proposals per proposer. The Email page holds the Gmail
original, per-Purchase links with Link/Dismiss and changed-since-review warnings; another member's
Email reads as metadata only. Attachment source keys require the original to belong to the Email
owner. After page selection, association, review, Purchase-link and owner facts start together (no
serial awaits before `Promise.all`). Review facts read the Email's `EmailReview` rows for its current
checksum; a label is the row's stored `classification`.

### List views and timelines

`list.views` names the renderers (`table`, `shelf`, `timeline`, or a `slot` view with route-only
`searchKeys`); the first is the default and the generated search schema carries `view` when there
are several. `list.links` names header links. `list.timeline` names the date fields and lifecycle
keys the default timeline emits. `lifecycle.start` accepts a field key or an ordered array: an
interval starts at the first non-null field (Planting's `["sowedOn", "transplantedOn"]` covers a
nursery seedling), and the default timeline marks such a row `confident: false` when a fallback key
supplied the start. `capabilities.timeline` (`"default"`: audit log plus declared date fields;
`"custom"`: `extensions.ports.timeline`) publishes the entity on `entity.timeline`. The compiler
checks every named field, relation, descriptor, view and section id. An event's optional `amount` is
signed USD money (positive spent, negative recovered) formatted by the shared formatter; inventory
quantities belong in descriptive facts.

`edit.sections` (`[{ id, title, fields, collapsed? }]`) declares the editor's titled sections. The
compiler emits the complete list: every controlled field of the create/update rosters and edit
intents that no section names joins an untitled `main` section, which leads unless a bare
`{ id: "main" }` entry places it, and no field appears twice. Web `EntityIntentFields` and native
`GenericEntityEditModel` render that list as is. The image-block keys (`pendingImageIds`,
`pendingImagePurposes`, `removeImageIds`, `imageOrder`) stay out; the image block owns them.

Calendar-date periods are `kind: "dateRange"` fields with a `dateRange` declaration naming two
nullable stored date columns and `semantics: "deadline" | "period"`. Task `due`, Project `dates` and
Planting `season` expose one nullable `{ start, end }` value. A populated value has at least one
valid date; two bounds are inclusive and ordered on writes; reads preserve existing bounds for
correction. Null means unscheduled. Omitted update fields preserve both columns; null clears both;
an object replaces both atomically. The columns stay storage-only. These are calendar days, never
UTC-converted. Editors own one field and one validation surface: deadline start-only means one due
day; period start-only means From and end-only Through. Display, clipboard, scoped edits and bulk
updates carry the whole value. Sort/filter keys can name the underlying columns; timeline paths name
`due.start`/`due.end`. Project's derived effective dates stay a separate read-only `dateWindow`;
editing `dates` changes stored overrides only.

Every listable entity gets the shared List (`table`) and Cards (`shelf`) presentations without
requiring photos; first-view defaults are unchanged. Cards use the title and
`list.shelfSubtitleOverride` fields, else declared mobile subtitle metadata; missing captions stay
absent. Web RTable name cells show one line with no subtitle; `list.titleSubtitle` is native-only.
Server-resolved display images are reused, with the entity icon when none exists; exceptional list
projections use explicit adapters, not per-card detail requests. Compact is the card presentation
with screen-local density state (not a stored preference or URL parameter), carried across the
phone header boundary. Shared web and Swift grid components own tile sizing. All three presentations
keep the list's query, filters, sort and pagination; bulk selection and editing exist only in List.
`list.viewAliases` maps retired view URLs to a current renderer. `list.primarySearch` declares
exceptional search inputs without joining global search (USDA's `nameFilter`). Native read metadata
distinguishes generated resource readers from declared read-RPC adapters; it does not expand
`httpActions`.

### Bulk edit

Every entity with a normal update contract supports `entity.bulkUpdate` through one runtime. The
compiler derives the roster from normal update fields; there is no entity or field opt-in. Names,
external identifiers (barcodes, retailer SKUs, ASINs), images and attachments, and one-to-one links
are excluded by declaration metadata: `display.standard`, image references and unique single-column
FK indexes supply the semantics, and `semanticRole: "externalIdentifier" | "attachment"` marks
ambiguous fields. Shareable references stay editable. `bulkUpdate` in the summary and
`entityFieldModels[entity].bulk` share this roster, which covers all mutable shortcode entities,
including update-only ones such as imported Cookbooks.

The web `bulkEdit` action, MCP and native (`bulkFields` in `entity-kernel.json`) expose the same
roster. The web dialog uses normal intent controls with unchanged/set/clear modes and submits only
touched fields. Nullable scalar controls share the form's empty `null` baseline; initializing or
resetting another field must never stage a clear; explicit `false` and nullable clears survive.
Value collections (tags, aliases) and multi-reference lists (Task blockers) accept only
`[{ op: "add" | "remove", key }]`; replacement arrays and renames are refused. Each row keeps its
unrelated values, additions deduplicate, and removing an absent value is a no-op. Resolved values
pass the normal update schema, including object refinements.

Every top-level list gets this patch contract from its input schema, including structured arrays. A
declared `collection.key` identifies record items: `{ op: "add", key: { purchaseId: "PUR-ABCD" },
value: { amount: 6 } }` adds one allocation and remove supplies only the key. Adding a held identity
with different attributes is refused (remove then add instead). Without a named identity the whole
item value identifies it, ignoring generated UUIDs and opaque read identities. Structured reads
project through the normal input description, including `readFrom`. `collection.readPath` declares
an authoritative projection when detail uses a different shape. An unavailable collection read
refuses the batch instead of treating it as empty.

Every exposed field has a usable editor control; only assignment-mode companions fold into their
value controls, and bulk rendering never silently omits a genuine update field. Native bulk edit
sets or clears single values (structured ones included) and adds/removes value collections and
multi-references; a keyed structured collection opens web's bulk edit. Structured changes use the
editor's wire normalization; empty optional lists are omitted. The dialog sends removals before
additions so a held keyed item changes atomically, and labels removal controls visibly.

Execution is atomic across the selection (1–500 unique public ids). Ordinary stored scalar columns
use one set-based UPDATE when the writer's `updatePolicy.recordFields` dependencies permit;
reference resolution, collections, compound values and opaque/domain writers run the normal
single-record update for every row in the same transaction. Shared CRUD updates read the live row
for before-state and audit diffs; relation hooks own collection snapshots; full detail hydration
runs only when the requested output needs it. Per-row audit, CalDAV guards, assignment and dependency
resolution, recipe costing, search projections and suggestion supersession follow the normal
mutation contract. A failure rolls back every row and pending publication; diagnostics keep the
failing rows and raw database details (SQLSTATE 23505 on a unique collision). Location reparenting
keeps Home and cycle checks; the arrange workflow delegates to the same runtime. Native has no bulk
update route or multi-select delete UI.

## Images and display sources

`capabilities.images` is `false`, `"gallery"` (ordered `EntityAttachment` rows, bound by
`galleryBinding(entity)` in `server/db/helpers/crud.ts`), `"cover"` (one `coverImageId`, Cookbook) or
`"logo"` (one direct logo FK, Vendor). Bootstrap generation reads that literal into
`entity-definitions/image-association-storage.gen.ts`, which Image validators import, so association
targets need no hand-kept roster. A gallery's public `images` read embeds live Images on every
projection unless the declaration narrows it with `fields.embedded`. The manifest keeps `hasImages`
(`gallery`/`cover`) beside `imageStorage`. Every public list and detail read carries server-resolved
`displayImages: [{ id, url }]`; details also carry directly owned `attachments` with role and
position. Image-ingress bindings use `source-id` for a singular reference and `source-id-list` for a
multiple one, compiled against declared cardinality; no workflow branches on a field name.

An entity with image storage declares `capabilities.images.displaySources`; there is no default. An
entity without storage borrows from a ranked singular outgoing relation to an Image or image-storing
subject (direct Image references first); `displaySourceOverrides` replaces that ranking and `[]`
opts out; the schema rejects the other name for each kind. Only declared paths are followed;
incoming activity is never discovered as a fallback. Declare sources in preference order: array
position compiles to priority after directly owned images, ordering defaults to `declared` (explicit
`newest` or `oldest` when needed), and borrowed imagery always compiles with `identityEvidence:
false`. Visual-evidence ranking is a separate contract.

The resolver in `server/entity-kernel/repo/entity-display-image.ts` composes these paths breadth
first in one SQL read: direct displayable images, then directly related images in declaration order,
then deeper fallbacks. Identical expanded paths run only at their earliest priority while traversal
continues. Purchased-Product paths share one effective Project/Product pair per query; Product and
Vendor ordering stays authoritative. The expense connector's Project scope comes from the compiled
path prefixes (including inherited Task Projects); the household fallback keeps its wider
candidates. Unrelated batch companions cannot change a record's images. Each record combines its own
and borrowed images with canonical ordering and deduplication by Image id, so an overlapping image
counts once and its earliest source wins. Each path visits a subject kind once, so reciprocal
Recipe/Meal and Task/Project policies terminate; each relationship keeps its newest/oldest ordering
before nested relationships and attachment order. Unavailable files, PDFs, deleted records and
Product label images never become covers. Web and native render the first result and derive no cover.

Products fall back to their Brand's logo, which consumers (Inventory, Ingredients, Expenses) borrow
through declared paths. Expenses reach the seller logo through their Purchase; Vendor is
Purchase-owned, not an Expense assignment. Source transaction records borrow the linked
FinancialTransaction's images through the accepted-settlement relation, including Purchase and
Vendor fallbacks; when those yield nothing, a unique supported merchant inference may supply the
Vendor logo as a decorative fallback (ambiguous history never does, and it accepts no match).
Display-image quality presence uses the same paths. MCP Product projections expose the same cover
URL; owned gallery cover flags identify a match rather than choosing another image. Calendar range
items and Location trees carry the same `displayImages`. Picker cover/logo URLs serialize the
resolver's result. Internal one-cover readers use the cover query instead of full arrays; gallery
and image-chain readers keep complete arrays. Presence checks keep their inline existence path.

The exclusions in `packages/schemas/src/image.ts` own file displayability; the in-memory predicate
and aliased repository SQL compile the same declaration. Attachment liveness and purpose stay
relationship rules at the resolver.

## List presentations

### Named groupings

Named groupings are code-declared saved views with category, family, location, brand or tag
filters; Locations provide physical grouping ([ADR 0022](adr/0022-named-groupings-are-saved-views.md)).
Product and Location tags are plain tags. The Product Category family column reads the effective
inherited family, matching its filter.

### Declared board lists

A `kind: "board"` list view configures grouping choices, card fields, intrinsic filters, per-group
caps, page size, ordering and an optional reorder command; `model.grouping` stays the authority for
groupability and filter bindings. Both clients read group summaries from the full filtered list, then
query bounded card pages per group. A cap limits cards, never the header count. Move and reorder
submit one declared workflow command to the domain transaction: clients send neighbor anchors and
the destination group, and `task.bulkReorder` computes sparse ranks over the complete group,
rebalancing only when no rank fits; rebalancing preserves unseen rows and their timestamps. Clients
never number a partial page or split a move into writes. Capped recency groups allow moves between
groups but no manual ordering. Task trade grouping uses the required effective trade; clearing an
inherited source must still leave a resolvable trade. No-value groups without a declared no-value
filter are readable but cannot be destinations or reordered; no-project placement uses the
reference-presence filter; clearable choices keep their no-value destination at zero count.

A view with `reorder` supports manual order. A view without one (Projects) moves a card by writing
the grouped field through `entity.update`, so it has no order within a column. Web boards use
pointer/touch dragging; keyboard users use the card menu's Earlier, Later and Move to. Drag grips are
excluded from keyboard focus and the accessibility tree.

### Fixed-filter list embeds

`EmbeddedEntityList` in `entity/entity-list/generic-entity-list.tsx` embeds an entity's ordinary
columns, list read, progressive enrichment and ListWorkbench. Callers supply an entity, fixed
filters or a saved view id, a page size, optional columns/sort and an All N link. Each embed owns
local table state and never reads or writes its host's URL filters/sort (the host may derive fixed
filters from its URL). Saved-view filters and fixed scope compose through the manifest; links encode
the same effective filter. Embeds stop at their bounded first page, use the shared table's inline
detail rows for disclosure, and use sheet-only row inspection at every width.

### Calendar list presentations

`calendarSources` in `packages/schemas/src/calendar.ts` declares the combined calendar's sources:
Meals, Tasks, Spending, Projects and Planting lifecycle milestones. Source identity is separate from
entity identity: Spending projects Purchases plus standalone and planned Expenses; links, covers and
edits use canonical entity kinds and ids; occurrence keys distinguish Purchase originals, dated
refunds and Planting milestones. Garden feed UIDs are unchanged.

The range hydrates Meals, Tasks and standalone Expenses through selected-field scaffold reads that
request only geometry, summary and envelope values (no dependency collections, subtask counts or
per-source media). Meals reuse the selected ids. Canonical images resolve once for the range,
concurrently with the spending-context read. The response keeps daily nutrition totals, image
lists, assignment controls and provenance.

Chips show explicitly assigned Projects (not inherited defaults), otherwise the largest effective
spending category, and spending beneficiary LedgerParty names, including a Purchase occurrence's
contributing lines, from the effective spending allocation resolver and its
[default and override policy](household-contribution-ledger.md#presentation-and-unknowns).
Identities and inheritance state ride in the range batch: chips draw initials for recorded
beneficiaries and the inspector adds inherited ones with their markers, without per-row lookups.
Spending events also carry effective spending-category allocations and their lines' Product
categories, each with its emoji and amount, largest first; within a day, spending sorts by amount
below meals and tasks. Explicit unknown attribution stays blank; unpriced
lines keep recorded beneficiaries without fabricated allocations; absent project context has no
placeholder. Spending omits discards (zero or unknown cost with negative product quantity); refunds
and sales stay.

Spending is computed from relationships, not stored: batched Purchase evidence loaders feed pure
calculation functions. One original Purchase event uses its order date, else original Expense
dates, else allocated payment dates; its amount uses the receipt total, else original Expense costs,
else allocated payments. Later card posting never creates another event. Negative principal lines
and refund allocations produce separate refund-day events, coalescing evidence; negative receipt
adjustments stay in the original event. Missing refund dates use source evidence or an unambiguous
allocation before the stored date; no records are rewritten. The inspector shows the line breakdown.
Daily recorded-spend summaries stay Expense-based; the calendar is an activity view, not a posting
ledger.

Each source has a Calendar list slot; switching between table and calendar keeps entity filter
state, and calendar navigation uses `period` and `calendarDate`. The combined Calendar namespaces
filters by source (`task.status`, `spending.future`); every active source filter narrows the whole
population, so filters from two sources match nothing. Spending filters reuse Expense list
predicates; a Purchase matches when a related Expense matches, and its event stays whole. Fully
undated records produce no events; Projects fold dates over the whole tree before matching. Meals,
Tasks and planned Expenses can move; Purchase events, actual Expenses, Projects and Planting
milestones are read-only. Calendar range and schedule reads take nested source filter records through
POST, shared by web and native.

Table grouping stays in URL state and is unavailable with a reason in calendar mode. The desktop
calendar offers Week, Fortnight, Month, 3 months, 6 months, Year and Schedule in one picker; long
periods use calendar quarters, half-years and years, and previous/next step by the period. The day
grid fits the viewport below the shell. Align weekdays defaults on and persists locally (rows of
multiples of seven columns; free wrapping otherwise); month boundaries stay visible. Padding cells
never extend the 366-day range query. Event bars reuse lane packing, with long bars folded into one
"N ongoing" lane as in the month grid; hidden events keep per-day overflow counts. Selecting a date
opens an anchored day popover; selecting an event there opens the record inspector. Overview modes do not support dragging; phones keep the
short-period agenda. Schedule keeps Task and Planting lanes and undated scheduling rows; other source
filters stay in URL state, disabled with a reason, until returning to the grid. Queries show a
hydration-stable loading state after scope changes (never an empty or previous-scope calendar);
same-scope refresh keeps events mounted with the shell's syncing indicator; failed reads show raw
diagnostics and Retry; empty messages appear only after success.

## List columns and display

The `model.fields` roster owns field kinds, read keys, labels, validation, controls and display
membership. `EntityBasicInfo` reads `display.detail`; `createEntityDisplayColumns` reads
`display.list`. List suggestions target visible columns, so a suggestible field must declare list
membership to be reviewed there. Fields owned by a dedicated section stay outside the
basic-information roster; `EntityBasicInfo` takes a declared `fields` section's keys
(`entitySectionFields(entity, id)`), and `EntityBasicInfo.afterFields` anchors computed facts after a
declared field without inventing persisted fields. Unknown detail override keys and anchors fail.
Detail overrides may supply a dynamic label when the value changes meaning (ISBN versus UPC).

### Renderers and display projections

A field's `display.renderer.list` or `display.renderer.detail` selects a semantic renderer while the
declaration keeps membership, labels, order and widths. The generator emits narrowed TypeScript
renderer ids and Swift renderer enums; each platform keeps an exhaustive registry marking every
declared renderer and slot implemented, generic, owned by its container, or unsupported with a
reason. A legacy field override and a manifest renderer may not claim the same surface; the compiler
or registry test fails instead of choosing. `control.renderer` follows the same contract for form
controls. Executable queries, runtime option providers, heterogeneous trees, dialogs and workflows
stay hand-written. Declare object-valued outputs as `json` and render them through explicit
overrides; a logo object is not a text field.

A structured value every client would otherwise re-word declares where the record carries its text:
`display.labelPath` for a list cell, `display.detailLabelPath` for a detail row (a server-composed
sentence, lines joined with `\n`, built in `server/entity-kernel/repo/detail-display-labels.ts` and
carried as a `labelField`), `display.itemsPath` for worded rows that each open their record
(`displayItemsField`), and `display.readPath` plus `format` or `valueOptions` for a nested value.
Enabling a structured editor on a detail field requires one of these projections. Allocation rows
keep their Purchase link and server-formatted amount. Histories naming other entities use
`itemsPath` so each party stays navigable; never flatten references into `detailLabelPath` text.
Clients print what the record carries. A generic native list renderer declares `display.labelPath`
for scalar fields (the field's own key when it carries the value); a date or timestamp self-label
keeps native date presentation and spoken text.

`display.value` declares a cell's semantic kind when it differs from its stored shape, including a
structured record link's target and cardinality. A presence filter still edits yes/no without making
the cell boolean; the compiled filter label names its predicate separately. Standard image columns
keep media semantics. Reference groups with a computed public title read the canonical repository
title SQL, prepared once per list context. `display.valueOptions` is the label/tone roster for an
enum-like value rendered without a select control (a derived status, or a JSON field's
`kind`/`status`); read it through `fieldEnumOptions(entity, key)`. `display.preview` marks the hover
preview card's facts (compiled to `detail.preview`, in model order); a computed figure the card needs
is a read-only projection on the server output, never a web-side map. An entity with no preview
field falls back to hero stats and its first section. List-only figures needed by compact cards
declare `display.preview` explicitly, so removing a hero stat never silently removes a compact read.

The list-field compiler owns `listFields.presentation`: semantic labels, descriptions, entity
targets, value types, cardinality and admitted sort, group and filter keys with unavailable reasons.
Shared web columns and menus consume these facts rather than guessing from storage shape.
Relationship counts keep their record target but expose a scalar value. A grouping operation owns
its own type: a repository yes/no predicate can share a key with a displayed count and groups by the
predicate's scalar shape and presence filter. Relationship previews contain records; their sort
follows the first chip in the view's declared order. Sort controls offer supported hidden columns.

### Columns and defaults

Every list column falls in one bucket. A generic column is a schema-eligible scalar with
`display.list` enabled, rendered by `createEntityDisplayColumns`. A declared column with a named
renderer is rendered by the platform's manifest registry with the declared label and sort. A legacy
override remains only as a migration seam for specialist columns. An explicit `add()` outside the
declaration is reserved for client-hydrated data, relation projections, a second projection hosting a
filter control, and the synthetic identity column. A field without a scalar read key needs a valid
surface read path, a real nested reference identity, or a classified renderer with a proven input
projection; the compiler traverses dotted keys, `[n]` and `[]` through optional, nullable, lazy and
compatible union schemas, and validates list labels on lists and detail labels/items on detail.

`display.listHidden` owns a declared column's hidden-by-default state; pages keep
`initialColumnVisibility` only for computed or relation columns outside the field model. There is no
separate default-column roster: set `listHidden` on columns that are near-constant in practice ("1
each", "Stock", "Needs data", an identifier or flag empty on most rows) so placement, owner, value,
due date and status lead after the title. Order with `listOrder` when model order puts them late,
and keep a band's members together: web paints a `columnGroup` at its first member's position,
hidden or not, while native sorts by `listOrder` alone. Web tables, Mac tables and native rows start
from this state. `display.width` buckets a column `xs` to `xl` (`xl` for prose such as notes).

`display.detailOrder` places the title first, then model order. `display.listOrder` orders columns
independently (model order also drives forms) and must be a nonnegative integer differing from the
default. `display.columnId` keeps a stable id when the key differs; ids are saved layouts, filter
bindings, sort ids and saved-view keys, so a rename is never free. Active column ids are unique; an
override must match a declared list field, and one claiming the `titleField` identity column fails.
Computed identities and domain summaries outside the field model stay explicit columns. Composite
cells suppress their supporting fields so ids, names and logos are not shown twice. Standard name and
image columns come from `display.standard` on their fields. Mobile title slots use the column
accessor value, so linked identity columns return the readable name and keep the shortcode for
navigation.

`display.columnGroup` declares each list field's header band, shared by related previews and custom
column helpers; every entity opts into bands in its declaration, never a browser field-name
heuristic. `display.columnBar` adds a loaded-row magnitude comparison to a numeric field without
changing its value, sort, clipboard or editor; use it only for comparable units
(`apps/web/docs/web-ui.md` owns rendering). A range filter's presets are declared as
`options[].expand` patches (`{ costMin: 500 }`) and the generator emits the expander; a
today-relative bound is a static `@today-Nd` token, so only presets that cannot be static (calendar
windows, open-ended counts) keep an `expandRef`.

### Trees and nesting

`model.hierarchy` (`parentField`, `maxDepth`) names a readable single self-reference and the depth a
well-formed tree reaches, bounding tree displays and Group by levels. Filter descendant expansion is
cycle-guarded but not depth-capped, since writes do not enforce `maxDepth`.
`presentation.list.tree` opts a hierarchy into nesting and requires it; Location, Task and Project
declare a hierarchy without a tree. Nesting is a server scope, never client stitching: every list
read of a tree entity (`entity.list`, `entity_read.list`, HTTP) accepts `nesting` —
`{scope:"flat"}` (the default), `{scope:"roots"}` or `{scope:"children",parentId}` — applied after
the same filters and sort. A root is a row whose parent is null or does not match the filters
(judged over the whole filtered set, so a matching child of a filtered-out or deleted parent stays
reachable). `roots`/`children` rows carry `childCount` (directly nested matching children), kept as
structural metadata even in selected-field reads, and `totalCount` counts the requested scope. The
shared scaffold (`server/generic/list/repo/list.ts`) owns this. A specialist client tree declares
`nesting: "flat"` on its list-read projection so loader and table share one roster.

The web table pages roots and reads an expanded row's first children page through the same query; a
status row after the children shows loading, a failure or deferred group with Retry, and Load more
while more children exist. Expansion resets when filters or sort change. `tree.toggle` adds a
nested/flat switch (a row of the phone Filter sheet) persisted as `nest=on|off` (absent is
`tree.defaultNested`, default nested). Grouped nested rows section by their roots; cards and the
timeline stay flat. A whole-tree view (the category hierarchy chart) reads `useServerTree`: roots,
then each counted parent's children, level by level. Promoting a declared filter column to primary
search keeps its URL codec and maps to its wire parameter for native.

### Sorting

`model.sort.fields` is the ordered, complete sortable-column list. `defaultOverride` replaces
`createdAt` (or the first sort field) and `directionOverride` the kind-based direction. Every entry
is a `model.fields` key, a `model.derived` key or a `related:<view>` preview. A sort whose value is
not its stored column (a vendor's live purchase count, a reference ordered by its effective record's
name) is a `model.derived` key, so no repository resolves a sort by hand. `defineRepository` derives
the kernel's sort contract from the generated roster. Native sort changes restart pagination with
the active search and filters. A rank used only to order rows (`rankOf`, such as Product's category
path order) is never selected as the row value.

Every compiled sort part orders NULLS LAST in both directions unless it declares `{ sql, nulls:
"high" }` (empties first when descending: a vendor's latest purchase) or a fixed `direction` (an
Email's received time stays newest first within one link state). A `related:<view>` entry orders by
the view's first chip (`relatedSortExpression`). USDA food lists read the external release, a
declared exception whose service orders by its declared values.

### Saved views and member filters

A saved view may declare `view` (the list view it opens in, such as `shelf`) and `pin: { surface:
"home", order }`, listing it in the home "Your views" row on web and Apple; neither affects
active-view matching. Native saved views compile column filters into operation JSON inputs,
expanding nullable sentinels into presence filters and static range presets into their patches;
generation refuses an unsupported expansion rather than dropping scope. Applying a native saved view
replaces filters and sort in one refresh. Native manual reference selection applies the
declaration's explicit-intent patch before its value, so choosing after Use inherited replaces the
staged reset. Every filtered task presentation (Next, charts, board, timeline) resolves `@me` before
reading.

Task and Project assignees use the identifier field's member-scoped LedgerParty picker and the
`assigneeId` / `assigneeMode` inheritance contract; both references declare outgoing paths and
incoming inverses for their stored foreign keys alongside member lifecycle policies. Reads expose
`fields.assigneeId` with the effective id, provenance and label; filters and sorts use the same
effective SQL. Explicit null means None and reset clears the override. Project's label is Default
assignee; Task's is Assignee. My tasks combines open status with `assigneeId: @me`; a filter declared
`currentMember` accepts `@me`, which the kernel resolves to the actor's linked member (nothing
matches without one; [ADR 0018](adr/0018-current-member-filter-token.md)). Unassigned uses the
presence filter.

Inventory's `fields.ownerLedgerPartyId` separates the stored choice from the effective owner, so Use
inherited, Keep this value and Set to Household are the generic resolution actions
(`resolution.confirm` pins the inherited value; `resolution.labels` names a null value Household or
Unknown). Saved explicit intent keeps its reset action before a derived resolution is published; the
explanation loads the ownership ladder and exact reset outcome on demand, and a successful empty
outcome is known absence. The owner filter runs the ownership resolver and narrows by id before
paging; the declaration's filter `sentinels` (`@household`, `@unknown`) are offered beside the roster
and sent unbranded; values are ORed. Product's derived `owners` (display format `resolvedList`: a
label, an optional record, and whether it is only inherited) rolls up its live entries for the page's
rows, and its owner filter adds `ownerPresenceFilter` plus Unlocated products whose single
acquisition would hand the owner down. My stuff, Wardrobe (`apparel` family), Books (`books`),
Records (`music`), Bought for me and the ownership work queues are saved views over these filters.
Books and Records include `@me` and `@household` owners and stock placement; Books groups the shelf
by category level 2, Records sorts by Product without grouping. Home pin orders: Wardrobe 0, My stuff
1, the task view 2, Needs a home 3, Books 4, Records 5.

### Option colors and roster counts

Enum presentation is authored in the owning roster. Field display metadata `optionRole`,
`optionColor` and `optionGlyph` supplies defaults for `control.options` or `display.valueOptions`;
each option may override color or glyph. Colors are keys from `packages/design-tokens/tokens.json`
(`domain-house`, `positive`, `neutral-status`). Status rosters use condition tones with their
standard glyph; category rosters choose contextual glyphs and stable colors, which several values
may share. Unknown choices declare neutral presentation explicitly. `compileEnumOptions` completes
and validates presentation once, with errors naming entity, field and option; read-only enums
declare `valueOptions`; Zod enum coverage is checked against the roster; no spelling, order or color
infers semantics. The compiler projects token keys into the cross-client CSS-token wire form and
generates static browser icon imports; UI-only sentinels live with their web option declarations;
renderers draw resolved presentation without rerunning completion. The design-token generator
supplies CSS and Apple's adaptive color assets. Color supplements the visible label. Specialized
surfaces (task-board trade badges, native journal rows) resolve the same field option color.

`dashboardLocalCounts` owns the local navigation-count roster, including Spending Categories; the
server count query and web navigation derive their keys from it. Each entry uses its entity's
unfiltered list predicate. Missing responses stay absent; loaded zero counts stay visible.

## Grouping, pivot and totals

`model.grouping` supplies preferred ordered Group by choices, including text fields and related
paths; the compiler then infers eligible enum, reference, boolean and calendar-date fields.
Generated choices carry their filter, no-value label, multivalue capability, ancestor levels and
date buckets. Unsupported SQL sources stay disabled with a reason, and the kernel validates the same
capabilities for every client. Menu admission is separate from read projections and from accepted
request keys: deletion timestamps, calculation timestamps, leases, override modes, internal fields
and duplicate SQL values stay out of the menu while their keys stay valid, so hiding a choice never
invalidates an existing grouping. Implicit choices require a public field surface, canonical
reference, same-field value filter, or the backing bound of a declared date-range field. An explicit
`model.grouping` entry can keep a useful backing choice (a Cookbook import date). Authored choices
win; otherwise the choice matching its filter column wins. Derived expressions keep their own key.

Record-picker filters on local-path related previews also supply grouping choices through their
relation declaration (label, target, traversal and drill-down binding); no duplicate
`model.derived` alias is needed, and equivalent stored-reference and related-path choices share one
entry. Query-backed and external relations do not acquire SQL grouping from a preview.
Preview-derived grouping reuses the related-view reader's full evidence union, view conditions and
filter traversal, and never reduces a multi-source preview to its first path. A stored-result
reference with an explicit `storedProjection` and a scalar list binding groups through that
binding's target UUID. Inventory Owner reuses the effective-owner filter identity; its combined No
resolved individual owner section (Household, Unknown and pending) has no exact filter, so its
drill-down and exclusion stay unavailable. Record-valued group headers share the identity-mark
renderer and display-image batch with relationship groups. Relationship grouping labels prefer the
declared relation label.

Derived aliases bind drill-down through the same compiled relationship path. Calendar aliases must
match the grouped value's path or key: a date window's effective deadline filter cannot stand in for
its stored start. Public calendar groups declare same-value ranges; computed timestamp ranges and
facet bounds use whole household-local days through the same helpers as stored timestamps. Ancestor
drill-down and exclusion require an exact subtree filter binding; otherwise they stay unavailable.

### Requests, levels and buckets

List requests and supplied views use `groupBy: [{ key, level?, bucket? }]`, at most three unique keys
in hierarchy order; empty means ungrouped. Web URL state encodes that array in `groupBy` (no
standalone `groupLevel`). Supplied views are declaration-backed only; there is no user view
save/manage interface. Timeline keeps its own arrangement and disables Group by. Native ranked search
suspends grouping and restores it afterwards.

A reference to a hierarchical entity can use an absolute ancestor `level` (1 = root); shallower
values group under themselves. Web Display → Group shows Grouping level in each hierarchical field's
submenu (Exact, Top level, Level 2 and deeper) and beside the field. Entering Pivot, or adding
Category in Pivot, defaults Category dimensions without an explicit level to Top level; explicit
levels survive layout changes and Exact stays selectable. Calendar buckets are day, week, month,
quarter and year (omitted on a date field means day); plain dates keep their calendar value and
timestamps use the household timezone. Nulls and empty memberships use the no-value sentinel and sort
last; enums follow declared order; references use readable labels with identity tie-breaks.

### Memberships, summaries and margins

SQL expands multivalue memberships before paging. `items` holds unique canonical records;
`meta.memberships` assigns each displayed occurrence an `{ id, path }`; `meta.membershipCount`
controls occurrence pagination; `meta.totalCount` counts distinct records. Never assign rows to
sections by slicing summary counts or deduplicate occurrences by record id; canonical ids own
selection, editing, enrichment and mutations. Custom list sources must keep their joins and
predicates in membership and summary queries.

`meta.groups` holds authoritative summaries for every path prefix over the complete filtered
population. `key` is the JSON-encoded path; use `path[depth - 1]` for a dimension's filter value. Each
summary includes distinct count, parent count, fraction (null for a zero denominator), overlap and
optional metrics. A record counts once per prefix even when several leaves share it, so sibling
counts can exceed their parent. With two or three dimensions, `meta.margins` adds distinct counts
prefixes cannot express (each column value alone, `dimensions: [1]`; with three, each row and
sub-row pair, `[0, 2]`); totals read margins because summing cells double-counts. `pagination.pageSize:
0` with `groupBy` returns counts, summaries and margins without rows (`hasNextPage` false); the
count-only intent still drops grouping. No client-side sum substitutes for authoritative counts.

### Pivot

Every list with at least two groupable choices offers a built-in Pivot view (`?view=pivot`); it is
never declared per entity. Dimension 1 is rows, 2 columns and 3 collapsible sub-rows, read through
the page-size-0 request. `?share=` picks Count, Row %, Col % or All % (Row % when absent). A saved
view opens in it with `view: "pivot"`, at least two usable `groupBy` dimensions and an optional
`share`. A cell drills into the table through the same rule as "Filter to this"
(`entity-list/group-drill-down.ts`): calendar buckets use the field's date-range filter, booleans
its boolean predicate; unmapped choices and unsupported no-value cells stay unclickable. Desktop
Pivot offers record count or an admitted metric; cells, row, column and sub-row totals and the grand
total read the same scoped facts, counts still determine overlap, and signed metrics use numeric
values with partial guidance, never count percentages or count heat shading. Apple ignores the Pivot
view id and keeps the grouped list.

Web section headers show full counts and collapse independently without changing membership,
selection or later groups; collapse state is scoped to entity and dimensions. "Filter to this"
applies every supported prefix filter with ancestor subtree semantics; calendar buckets use
inclusive plain-date bounds resolved in the household timezone (including DST). "Exclude matching
records" (Hide) exists only for a single root value with an exclusion filter, since a flat exclusion
cannot negate a multidimensional path; native multidimensional leaf menus are disabled for the same
reason. It removes whole records, including their occurrences in other groups; filters select whole
records too.

### Group totals and evidence metrics

A `presentation.list.totals` entry with `group: true` also sums per group, and section headers show
the mean over records with a value (`sum / presentCount`) beside the sum. `listGroupMetricKeys`
(`entity-definitions/list-group-metrics.ts`) builds that roster from group totals and rail fields
with `total: "sum"`. The compiler emits labels and formats and rejects unsupported or mixed-unit
sources. Monetary values keep `SUM(Expense.cost)` provenance; field names never imply currency.
Per-prefix metrics distinguish unknown sums from zero with present/total counts and coverage.
Loaded-row reductions cannot supply filtered-set analytics.

`presentation.list.evidenceMetrics` declares additive contributions from a typed repository row set:
canonical contributor identity, nullable numeric value, optional admission predicate, unit,
descriptions, compact-summary visibility and explicit group-key-to-reference bindings. A metric may
refine an existing scalar sum key with coverage, keeping that key and its column. The compiled owner
validates identities, numeric/boolean columns, formats and group reference targets. One row-set
source is shared across its metrics; relationship memberships join filtered owners in one pass;
metric coordinates join the shared evidence rather than rescanning per group; binding projections
materialize once per contributor. Narrow internal `raw` readers omit ungrouped metric evidence. The
grouped reader deduplicates contributor identities at each prefix, margin and full-filter total,
never by amount. Bindings constrain the same contributor row; only dimensions present in the scope
constrain a parent or margin. Empty evidence is a known zero; null amounts stay unknown and count
toward coverage, with a partial marker beside known subtotals. Phone keeps the grouped list and
contribution disclosure.

### Product sellers and spending evidence

Product Sellers use acquisition evidence per Product and Purchase: actual vendor-role Expense
acquisition lines or a live explicit `acquisitionConfirmed` link. Signed refunds on an eligible
acquisition stay included even when net cost turns negative. Buying one Product does not classify a
different trade-in on that Purchase as acquired. Plans, reimbursements, bare identity links and
negative amounts alone establish no seller. Seller membership holds only live known Vendors; "No
seller" means no known acquisition seller (including deliberate acquisitions without a
counterparty) and is not a repair request. The broad Vendors relationship keeps its meaning. The
Product Sellers report reads the same acquisition relation, counts distinct Purchases and opens an
exact Vendor-id list. The Vendor manifest exposes the kernel's exact `ids` restriction as a record
filter that round-trips through the route schema and filter codec.

Product expense total covers all live direct `Expense.cost` evidence. Seller spending covers actual
vendor-role lines of eligible acquisition pairs, including signed refunds. Actual vendor costs
lacking a live acquisition seller are Unattributed spending. Plans and actual reimbursements stay
separate in contribution details; the four categories partition the Product's expense evidence. A
Product with known sellers can have unattributed spending without a No-seller membership; those
amounts stay in parent and global totals. Direct costs do not include Purchase-level tax/shipping
allocated in other financial views.

### Selection

Complete matching selection uses `entity.selectionIds`, separate from hydration. Its filters,
nesting and `resultMembership` mode define the population; bounded pages return public ids, total
count and an opaque cursor, each page in one SQL snapshot. Later pages refuse a changed id
population, including same-count replacement; there are no cross-request locks, and data-only
changes do not invalidate the cursor. Web cancels on scope or selection drift and applies selection
only after the full traversal. Bulk actions hydrate and check selected records before existing
eligibility and refusal rules; selection never grants permission to mutate.

## List reads

Each canonical page is one `entity.list` request returning complete rows, `meta.hasNextPage`,
full-filter `meta.sums` / `meta.totalLabels`, and grouping and membership metadata. Governed values
live only in each row's typed `fields` envelopes. Filtering, sorting, grouping, pagination and exact
counts stay server-owned. Web and Apple show whole-page loading and errors; repository batch bindings
never expose partial rows, field readiness, deferred groups or group retries. Browser roster
behavior (query keys, virtualization, declared demand on the client) is owned by
[web runtime](../apps/web/docs/web-runtime.md#list-loading-and-enrichment).

### Read ports and plans

Each repository supplies `listScaffold` as its read port to `defineRepository`; both constructors
receive their canonical per-entity schema ports explicitly. The `read` declaration supplies columns
and bindings: `{ scope: "detail" }` bindings default only on record reads (a page projection can
request them); `{ scope: "explicit" }` bindings load only when a projection names their keys,
including record reads and write-response hydration (use it for bounded verification bundles needing
their own snapshot). `scaffold.get` and `getByIds` use the same read plan as pages
([ADR 0024](adr/0024-repository-read-declaration.md)). The scaffold compiles one filter plan with
population, related scopes, result availability, joins and ordering under one owner; declared
rollups and result projections cannot be replaced by repository SQL, except an explicit contextual
`storedProjection`, whose declaration still owns availability and provenance. Filter-only
`fromResult` members use the same path SQL as visible stored fields.

A retention-managed read-only entity may omit `deletedAt`; readers apply liveness only where the
table declares it. `listScaffold.population` receives the same request filters for rows, facets and
selection. Explicit Run ids bypass the default automatic-purpose suppression, keeping historical Runs
readable; internal-id readers resolve public codes first. `populationFilters` names request options
consumed by that predicate (Job's internal-kinds toggle).

Repository `read.title` owns computed SQL labels; otherwise the scaffold resolves the stored title
field. Shortcode lookups, pickers and record graphs share that title. Generated kernel bindings
compile stored titles from `titleField` and lazily import each repository for composed titles and
field contexts; selected lists, selection identities and internal selected details load the
requested repository through the same loaders, whose read interfaces expose no write methods.
Missing ports throw; reads never depend on registration order. Queue and scheduled entry points keep
their lazy repository boundary. Browser detail requests load only their entity's repository and
share the command's get workflow; read-module imports must not initialize mutation or unrelated
operation handlers. Picker count and kind projections are declared by the repository, counts
compiled from the declared rollup. The shortcode table registry stays independent of repositories.

### Projections and envelopes

Browser rosters can send an explicit `fields` projection through the selected reader narrow
consumers use. The result carries `selectedFields` and honestly partial rows with canonical
envelopes. The pure read plan is shared by SSR and the mounted list. Named list renderers contribute
inputs from the shared renderer coverage catalog (visible fields, identity and image requirements,
specialist and action dependencies); membership, sorting, grouping and totals keep independent server
predicates. A route's `listReadProjection` adds only its specialist inputs. Selection-action
validation reloads complete records under the original scope; selecting a nested value keeps its
shape. Identity-only navigation declares `recordDemand: "identity"`; eligibility and mutation
actions keep the complete-record default.

A request for direct physical fields with no admitted bindings or field facts selects only those
fields plus internal id and shortcode, using the scaffold's narrow single SELECT without unrelated
row helpers. Published selected-field pages keep the declared full-filter summaries independently of
row projection and `includeCount`. Selected reads compile envelope demand from the manifest,
including projector and classification dependencies; governed fields keep assignment refusal and
automatic ownership when neighbors are omitted; identity-only pages skip envelope facts. Contexts
record covered fields so a narrow root cannot stand in for a wider nested read. Synthesized media
envelopes use loaded row values. Page and detail bindings receive the shared stored-data promise
before prefetch; its keys are the union of envelope demand and admitted bindings' declared stored
inputs. Automatic stored projections admit only selected fields. A loaded absence is distinct from an
unloaded key: readers reject missing coverage instead of producing placeholders. Own-table
declarations without a readable source keep their row value. Projectors declare cross-field
dependencies beside their source reference; generation rejects unknown fields and cycles.

The batch serializer keeps each root schema's output type after validation; public wrappers return
validated roots without reparsing; the envelope constructor applies declared projectors before its
final public-schema parse, and projector output never bypasses that validation. `entity.list` and
`entity.detail` add only server-computed action states. Selected list responses omit defaults for
unrequested keys; the browser's selected-list parse restores them. Build request-path schemas once
at module scope (selected envelope schemas are memoized per selection); per-request or per-row Zod
construction is measurable Worker CPU. Domain envelope projectors use their own per-entity schemas.
Public serialization reuses scaffold field contexts, else batches missing root and nested codes
through each entity's scaffold get. Inheritance resolutions produced during hydration contribute
their provenance.

### Bindings and batching

Stored metadata loads alongside hydration using internal ids. Image representations, processing
issues, import targets, analysis and capture parties prefetch from page ids; identification reads
live Product labels in the analysis query; confirmed descriptions join their correction receipts and
reuse the replay reader's authority validation. Bindings needing only page ids use `bind.ids` and
start as soon as selection finishes; row-dependent bindings use `bind.batch`. Both memoize within a
page, including transitive dependencies, and admit work only for requested canonical fields. Early
failures surface with the page; an abandoned row load leaves no unhandled rejection. Expense Project
and spending allocations use the id path. Independent bindings, totals and metadata run concurrently.

Requested attachment galleries prefetch representations by page ids. One media query returns display
images and attachment representations; the same resolver handles public image codes and owned live
attachments (including files excluded from display images). Only authoritative results from this
read seed nested hydration; supplied DTO representations never count as trusted preloads.

Generic browser rosters request the optional root `displayCover`: the canonical first image and the
complete deduplicated count, from the full resolver's candidates and ordering, with only the winner
joined to representation metadata. Empty covers are `{ image: null, count: 0 }`. Complete list,
detail, native and full MCP reads keep unchanged `displayImages`; the cover is list-only, never an
envelope, and absent unless requested. Product cover-URL bindings reuse the page's resolved images
when full media is requested. Browser roster projections include the synthesized Quality column when
readable and not hidden; its facts load without an ordinary field declaration.

Ingredient costing and nutrition graphs keep their graph readers but source Ingredient records and
embedded Products from their scaffolds; the enrichment workbench adds recipe count and cookbook-only
flag. Ingredient Product bindings request raw scaffold rows; the outer read builds nested envelopes.
Generic Ingredient rosters request optional `productSummaries` (identity, brand, canonical price,
label nutrition, unit mappings) with the same envelopes; complete `product` records stay for full
reads, detail, nutrition and workbench consumers, and a read requesting both shares one Product
load. Expense analytics remove share-scoped filters before preparing scaffold WHERE because
allocation shares apply them. Location identity and stock Product embeds load brand and category
summaries only. Project subtree reads load the tree beside household-grouped Expense and Task inputs
and apply the descendant scope in memory; a shared in-flight tree serves settings and rollups.
Product matched/mismatched quantity filters use the published Quantity Variance; a missing variance
has no comparison state, and an edit keeps the previous membership until publication.

Work Problems project filter values, readiness and related predicates into a materialized facts
relation per entity and request, then compute membership and label/authority columns once in its
base, admitting only records matching a certain or possible Problem. Bound values are part of
expression reuse. Compact reason arms only filter that base; reason declarations own actions and
ordering; possible matches with missing publications add completeness warnings, never actionable
rows. Routed label and owner expressions are deduplicated base columns outside the facts relation.

### Counts and totals

List inputs default `includeCount` to true for API, MCP and native callers. Standalone browser
rosters send `includeCount: false`: selection fetches one extra candidate, trims it before
hydration, and reports continuation through `meta.hasNextPage`; `meta.totalCount` is absent, never
zero or the loaded length. Exact relation pages and explicitly grouped pages keep exact counts;
view-count reads load exact totals on request. Full-filter financial sums keep complete semantics.
Complete scaffold pages and kernel-selected pages (including MCP summaries) include full-population
totals; raw selected projections and count-only reads skip them.

The scaffold selects relation-loaded page ids with a window count, so a nonempty page evaluates its
filter once for both rows and exact total; an empty first page has a total of zero, and later empty
pages count separately. Count-only reads, custom selectors and group summaries keep their own paths.
Tracing reports the combined phase as `entity.list.core.pageWithCount`. SQL-backed diagnostics carry
sample/count intent to their repository: counts load no presentation payloads and samples limit rows
before hydration while keeping the exact total. Algorithmic detectors may need complete input.
Finding samples use the same eligibility predicate as counts, ordered by creation time then id; only
selected proposed fixes are parsed, and a malformed selected fix fails visibly.

MCP `entity_read.list` keeps its summary, compact, explicit-field and full contracts on the same page
selector and canonical schemas, loading only bindings its projection needs plus the full-population
summary. Unknown fields fail before reading; required selected fields must load before schema
defaults run. Compact output omits media payloads and counters, long text and nested collections.
External USDA data stays a bounded batch inside the Product page read.

### Write receipts and collection patches

Create/update responses are bounded receipts across browser, native and MCP, including
`entity.commands` batches: the shortcode, canonical saved scalar values for explicitly submitted
fields, `appliedFields` and bounded warnings. Collection fields are acknowledged by name; the
response never reloads collections, dependent records, quality or recipe coverage, and
result-detail requests never turn a write into an expanded read. One generated receipt schema owns
every entity. Relational collection patches use repository collection adapters: the kernel owns
declared identity and patch preconditions, adapters read only submitted keys and apply audited
member deltas, and member lookups need matching indexes. Decoding an existing JSON column still costs
its size but never justifies a relational detail read or rewriting untouched child rows. Required
authoritative validation and audit records stay transactional; `sideEffects.derivedRefresh.mode =
"background"` describes freshness policy, not completed work.

### Product placement and search facts

Product complete list and detail reads carry `primaryPlacement` (nullable), read live in the page's
stock-facts batch: the live location with the greatest on-hand amount, then most recent stock activity, then
public location code. Its path joins ancestors and the location with `›`; identity Locations count
as one owned unit; services have none. It is read-only and the default column after Name, with a
mobile trailing path. Search hits carry at most three preformatted `facts`: Products show primary
path and a known on-hand label, Locations and Inventory their full path, other kinds none. Search
destinations, rows and typed pickers consume them directly; grouped inventory placement payloads keep
their own `locationPath`.

### Read timing harness

Timing evidence comes from `pnpm --dir apps/web exec tsx tooling/checks/read-performance.ts
--origin <origin> --output <artifact.json>` with `CUBBY_READ_AUTHORIZATION` or `CUBBY_READ_COOKIE`
in the environment; the script's options own sample counts, entity selection, concurrency,
`--input`, `--mode`, `--first-invocation` and `--caldav`. Credentials, response bodies, values, ids,
search text, paths and diagnostic text are never written; request ids and error codes appear only in
private raw output, and input fingerprints identify equal inputs without anonymizing them. Resource
GET pagination uses `page=1` and structured input `pageIndex=0`; keep compared populations
equivalent. SQL count, acquisition, query and client-queue times come from the `Server-Timing`
collector; absent, malformed, duplicate and streamed metrics stay null. Wall times do not establish
Worker CPU, decoded-row timing does not prove paint time, and the harness never infers cold starts.
Target warm usable lists below 500 ms (300 ms stretch), comparing full enrichment separately;
placement stays unchanged unless isolated repeated comparisons show gains without regressions.

`--mode list` records one `entity.list` per page; `--mode complete` measures the supplied resource
GET; `--mode operations --input <request.json>` measures the browser dispatch wire with a plain
`{ operation, input }` or `{ batch: [...] }` (2–20 registered queries), one transport attempt per
sample without batch fallback. Schema-5 artifacts separate HTTP, transport, dispatch, protocol and
RPC failures, report per-operation settlement separately from complete-response timing, and record
`requestedReads` and `workloadContext` (requested contracts, not observed work). Missing, duplicate,
out-of-range and unterminated result lines fail the sample; failed requests never enter success
latency statistics; any observed failure writes an artifact and exits nonzero (a correctness signal,
not a performance gate). Successful `entity.list` results record returned-row, total, unresolved and
incomplete-total counts, never row contents. `--context <context.json>` takes strict assertions
(`environment` local/ci/staging/production, `population` synthetic, `scale` 0–1e9, `cache`
warm/cold/mixed, `revision` the measured deployment's full 40-character SHA); missing fields are
null, extra keys are refused, and assertions prove nothing about scale, cache or provenance.

## Filters and search

### Search

`apps/web/src/lib/search-normalization.ts` owns search normalization: trim, collapse whitespace,
lowercase. Query input, document writers and embedding freshness SQL interpret the same recipe.
Purchase search titles use the order id, else the Vendor and optional date; an unknown date never
makes the title null. Exact name/alias resolution trims input and compares case-insensitively through
the shared name matcher without rewriting stored names; exact SQL keeps the indexed `lower(column)`
expression; Brand claims keep their trimmed-stored comparison. Candidate retrieval may add
punctuation, token, prefix or substring rules but never establishes identity from similarity alone.
Search eligibility, ranking and match captions share one array-element predicate owner.

Command search admits alias and identifier candidates through an indexed case-insensitive prefix
projection before the shared array matcher, which still decides membership and ranking. Array
membership has its own UNION arm so indexed title and full-text admission stays usable. Prefixes
cover the public query limit, including lowercase expansion; a bounded projection returns NULL on
overflow, and a partial index keeps those documents on the exhaustive path, as do LIKE
wildcard/escape queries and longer internal queries. PostgreSQL maintains these indexes with the
SearchDocument publication. Search embedding text is read directly from SearchDocument.

Semantic embedding inputs respect the model's token limit before provider submission and cache
identity. Builders put identifying fields ahead of free-form notes; long inputs keep a bounded prefix
for one-vector retrieval while source text and lexical search stay complete. Artifact hashes include
the full source text and, when truncated, the prepared input, so tail edits refresh the artifact
while the model cache reuses an unchanged prefix vector. Tokenizer work is bounded to four times the
token limit in UTF-16 units; literal special-token strings are ordinary text. There is no multi-vector
or chunk-averaging retrieval.

`presentation.searchFacts` declares zero to two ordered list-field keys for Cmd+K and full search;
generation rejects unreadable fields. They are separate from hit subtitle/placement context and
hover-preview rosters; choose facts that add context beyond title and subtitle. Grouped search
hydrates only returned records through the selected-field list reader, batched by kind; rows never
query data. Grouped search loads Inventory's field context explicitly for stock placements, so a
search-first request never depends on another route having initialized that scaffold. The shared
compact field renderer owns formatting; missing values leave positions empty and zero and false stay
values. Source transaction records declare statement date and reported amount; Purchase uses
Expense-backed recorded spend.

Related search preserves the semantic reader's coverage flag through grouping. Incomplete coverage
stays visible even with no matches; it is not a complete empty result. Pending publication work and
an exhausted candidate budget keep distinct explanations; only pending work is described as
updating. Coverage checks eligible sources missing a search document and published documents missing
a current embedding. Source edits may keep the prior published text until the next hourly pass while
application gates validate current evidence. Completeness never promises exhaustive ANN recall.
Provider and read failures keep scrubbed diagnostics and Retry without hiding lexical results; an
unavailable provider with no diagnostic stays unavailable, with no invented cause.

Task effective due dates use the ordered parts in `apps/web/src/lib/task-dates.ts`; in-memory reads
and SQL predicates compile the same precedence, while calendar overlap queries keep their start-date
fallback. Product expected-quantity range and unknown-quantity filters share catalog kit walks and
grouped Expense ledgers with the scalar and page quantity reads (signed unit contributions,
live-ancestor rules, weights, depth cap); missing history yields a known balance of zero.

### Filter semantics

Every value filter is any-of: `multiselect` and `idMulti` (a single-option flag is a `boolean`),
and a single value in a URL, saved view or MCP call reads as a one-element list (`oneOrMany`). A
compiled filter over a nullable field generates `<columnId>PresenceFilter`, offered as Any value / No
value options ORed with picked values; there is no `all` option or separate presence filter. Over a
reference, a soft-deleted record counts as no value, as in the group key, so a "No ‹field›" section
filters to the rows it counts; a retained FK to a deleted target is No value, and required references
gain a presence companion when their target supports soft deletion. Nullable stored flags expose the
same companion (false matches false; No value matches undecided). A hand-written value filter
declares `nullable: { field, label }`; Problem assemblies and UI adapters must agree on the presence
field, whose label is presentation copy. A filter over several values per row (a `text[]` column or a
`via` path through a list) also generates `<columnId>Match` (`any`/`all`), the Match all control. A
rosterless multiselect takes typed values. `currentMember: true` marks a Ledger Party filter that
accepts `@me` and offers Me ([ADR 0018](adr/0018-current-member-filter-token.md)).

Any value and No value lead a filter's value list above a divider; No value combines with picked
values, and picking Any value clears them. Chips join values with "or" ("and" under Match all); an
inactive chip reads "any" and an active Any value chip "has a value". There are no per-filter
meta-options (`all`, `either`), boolean AND/OR/NOT trees, cross-filter OR or typed search syntax:
any-of, Match all and Exclude cover household questions, and a rare cross-filter one is a second
query or the agent's.

Every compiled value filter (`multiselect`/`idMulti` over a stored column or `model.derived` entry,
plus the generic data-quality and pending-suggestion filters) also generates `<columnId>Exclude`
("is not") with the value key's schema; the filter record stays flat, so URLs, saved views, MCP and
Apple's filter dictionary carry it unchanged. Its predicate is the include predicate for the
excluded values negated as `NOT COALESCE((…), false)` (`excludedFilterRequests` in
`server/generic/list/repo/list.ts`): a row with no value stays (pair with Any value to drop empty
rows), a to-many path matches when no related row holds an excluded value, and excluding a hierarchy
node excludes descendants per the filter's subtree toggle. Include and exclude combine ("Clothing
except Outerwear"). Nullable Exclude keys accept `__none__`, negating the canonical missing-value
predicate while preserving positive selections; each excluded value and missing-value predicate is
negated separately, so a matching record leaves every group. A declared `predicate` is negated the
same way, so its SQL reads only the values it receives; request data it reads comes from a
filter-independent `sharedListPrepare`. A `listPrepare` load reads the request filters, so a
predicate over it throws when an Exclude key renders it. Web column state carries excluded values
with `FILTER_NOT_PREFIX` (`__not__:`), and each side shows its own chip; Any value, No value and
Match all belong to the include side, the subtree toggle to both.

Every declared filter is a Filters-menu entry. One no column hosts (a relation scope such as
expenses' `productId`) takes its field from the descriptor (`label`, else its placeholder's noun,
and Yes/No for a presence or boolean without options), and its value rides in the table's filter
state through the same URL codec and server builder; only a client-filtered table keeps column-less
ids out of TanStack state. A declared `label` wins over a hosting column's header; a related view's
text search is "<Target> search". Every list loads a deferred roster for each reference filter
(`useEntityList`); a caller's `optionsKey` list wins when supplied. URL value lists escape commas
inside a value (`joinFilterList` / `splitFilterList`). Two declarations of one request field (a
column filter and an older deep-link key) compile one as `aliasOf` the other; the codec decodes the
alias and writes only the canonical key. `singleValue.group` names scopes sharing one value (Email's
Purchase, Vendor and Vendor account): picking one replaces the others. A filter whose column differs
from its request key declares `field`; `urlKey` controls only the URL codec.

A field, path or layout the compiler cannot support stays in its menu, disabled, with a one-line
reason derived from the declaration, never hand-written per entity: web shows it as a secondary line
and Apple as a menu subtitle. HTTP and MCP reject the same request with the same text, unmasked
([README tenets](../README.md#tenets)).

Option discovery belongs to the filter declaration and shared picker runtime. Static options compile
as a fixed complete roster; `brandRef` compiles an entity-backed source. A relationship-scoped filter
declares `optionSource: { kind: "relation", relationKey: "product.vendors" }`; generation requires
the relation to belong to the source entity and target the same reference entity, and it keeps
relationship eligibility and distinct-source counts. Do not replace these with page-local
`optionsKey` arrays. Specialized complete vocabularies keep explicit loaders that drain all pages.
Tag rosters load from `optionsKey: "tags"` on opening a filter; Product and Location rosters count
distinct records; grouping, array predicates and rosters trim whitespace and omit blanks without
rewriting stored tags. Public enum groups reuse their exact filter's labels when the field has no
authored value labels.

Growing record rosters search their full eligible scope on the server and page on scroll, with an
accessible Load more fallback; the initial page is never a complete local-search roster. Selected
records resolve independently of search and paging; identities deduplicate by shortcode. Search and
scope changes reset paging, and stale requests never populate a new scope. Typed record pickers keep
lexical ranking and exact-code lookup; fixed choices and complete vocabularies search locally.
Pictures and marks come from the target's shared presentation and batched display-image resolver.
Initial loading, further loading, no matches and raw failures with Retry stay distinct, keeping known
rows and selections after failure. RTable checks a bounded loaded sample in development for
multiselect values missing from declared choices, skipping deferred and record-backed rosters.

### Filter compiler

Filter descriptors are typed metadata. Static choices stay in the declaration; icon-bearing option
lists, identifier brands and compound preset expansion use `{ module, export }` references. The
compiler rejects unsupported kinds and properties and duplicate columns or derived URL keys;
`audit: true` expands the standard created/updated date filters. A filter declaration compiles its
Zod-field binding and canonical URL keys, used by route search-parameter assembly, inspector
metadata and generated contract cases; static and deferred controls live in the explicit filter
catalog, and compound presets keep explicit codecs and loaders.

Every list filter predicate compiles from its declaration: `scaffold.where` takes the filters and a
read context, never a hand-written condition. A `stored`, `anyOf` or `derived` descriptor compiles
its predicate; the compiler infers no database behavior from any other URL key. A filter that cannot
be a stored column, a `via` path or a row set is a `model.derived` `predicate` whose `reason` lives in
the declaration. A list's static row scope and a project page's embedded scope are
[declared scopes](#declared-list-scopes) compiled into `where`, so no repository ANDs a condition
beside it. A filter over child or shared rows (import targets, settlement references, barcodes) reads
them through a [row set](#row-sets-and-same-row-matching). Calendar sources reuse their list
scaffolds, including prepared derived predicates and related scopes.

A `stored` descriptor names the standard predicate over one stored column. A non-text, non-range
filter that sets `deriveSchema` and whose `columnId` names a stored field gets that binding by
inference; `stored: { columns }` names the column for a virtual descriptor id; `stored: { array: true
}` marks a multiselect over a `text[]` column as overlap. Enum filters OR their declared `nullable`
presence in; a boolean over a nullable non-boolean column reads as presence (`true` is NOT NULL);
ranges are inclusive bounds read from their `wire` keys (`from`/`to`, and `presence`), and a
timestamp column bounds by household days. A range's No value ORs with its bounds ("recounted before
`@today-30d`, or never"); Any value beside bounds is the bounds alone. The compiler rejects every
other shape. A stored `text` filter ORs several terms when its value is a list, and a text
descriptor's `schemaRef` names that value schema (`expenseSearchTerms`).

A date range bound is a calendar day or a relative token `@today`, `@today-Nd` or `@today+Nd`
(`dateBound`). Like `@me`, URLs, saved views, Problems, MCP and native filter state carry the token,
and the kernel resolves it to the household-local day (`resolveFilterTokens`) before any repository
runs, so a saved view moves with the day. A date range's URL value is a preset key or `from..to`
(`..@today-1d` is "before today"); saved views, Problems and the native saved-view wire expand bounds
onto the range's keys, and the web and Apple editors offer each bound as a date or days relative to
today, keeping the token. A number range's URL value is a preset key or `min..max` onto its
`Min`/`Max` keys; the web editor checks typed bounds against the declared `range` (`nonnegative`,
`int`), shows `describe.lower`/`upper`, rejects a minimum above the maximum, and the codec drops a
rejected bound instead of failing the list. A range over a hand-written request schema declares the
same `range` limits, so an editor never accepts a bound its schema rejects.

A compiled id filter resolves its shortcodes inside the list query through `shortcodeIdsSql`; an
unknown or soft-deleted code matches nothing.

A text filter declares `anyOf`, the list fields it matches when any one does; the compiler ORs a
case-insensitive substring match across them. A member is a stored `text` or `text[]` field (by
element, read as its effective value when it declares `resolution.inherit`, so project search finds
an inherited location) or a `model.derived` key: a `via` path to a text field or titled record
(to-many as `EXISTS`, so a related-record search matches any live candidate's name, Brand name or
model, and task search the effective subject product's name) or a `type: "text"` value. A
multi-field search is that list, never a predicate. `anyOf` does not sort or group, and a text filter
never declares `stored`.

A filter descriptor reads a derived field named by its `columnId` by inference when it has no other
binding, including entries the compiler synthesizes. It declares `derived: true` only where a stored
field shares that key, or `derived: "<key>"` for another entry, so several filters share one value
or a column filters by an effective value. A value entry filters by type: `text` as a search term,
any-of or presence; `number`/`date` as a range or presence; `dateInterval` as a range (overlap) or
one date (containment); `boolean` as a flag (UNKNOWN reads as not met) or presence. Other values read
NULL as no value.

### Derived list fields

`model.derived` declares a list field that is not a stored column, or the value a stored field orders
and groups by when its column is not that value (`tags` by first tag, a reference by its effective
record's name). Its filter, sort and group share one expression
(`server/generic/list/repo/field-compiler.ts`); a stored field's filters stay on its column (its
effective value when it declares `resolution.inherit`), so only a `type` or `via` entry may name one.
Each key takes one shape:

- `{ via: "relation.relation[.field]" }` walks declared `local-path` relations to a record (its stored
  title) or a field of the last one. A filter compiles to `EXISTS` over the path; a sort or group to
  a correlated scalar subquery from the outer row's reference, even when the repository already joins
  that table (a measured cost earns a declared index, not a join-aware compiler). Only a to-one path
  supplies a scalar sort; unsupported sorts fail with the derived reason. Grouping expands to-many
  paths into distinct memberships; missing live values use the no-value bucket.
- `{ via: "<rows>.<terminal>" }` starts at a `model.rows` row set and takes one terminal: a row column
  (a JSON item key) or an entity the row references (`importTargets.run`), which filters by shortcode
  and gets the subtree toggle when it declares `model.hierarchy`. Record terminals group by distinct
  live identities with canonical titles and hierarchy levels; a missing or deleted reference in a
  populated row set contributes a no-value membership beside known references, and no rows also
  contribute no value. A to-many row set supplies no scalar sort; scalar row terminals cannot group.
  Value filters generate Any value / No value, Match all and Exclude.
- `{ type }` is a repository value passed as `listScaffold(entity, table, { readSchema, derived })`,
  whose argument type is generated, so a declared key without SQL fails typecheck. A compound value
  (an array of SQL, inventory `amount` as unit then size) orders part by part and cannot filter,
  except a `dateInterval`: its SQL is `[start, end]` with a NULL end open; a range filter matches
  overlap and a one-date filter (`param` wire, planting `activeOn`) containment; it sorts by start
  then end and cannot group. A state that is one row value is an `enum` value with disjoint `options`
  whose CASE yields nothing outside them (inventory `valuationStatus`, purchase `reconciliation`,
  product `quantityVarianceState`); a filter meaning several states picks them together. A value may
  be `{ value, set }`: `set` selects `("id", "value")` for the whole list and filters match `id IN
  (SELECT "id" FROM set WHERE …)`, while sort and group read the per-row `value`, which must agree
  row for row; a read binding supplies the projected value, and set-valued keys must be covered by
  one. A filter's `value IN (…)` pushes into a set whose branches expose `value` from an indexed
  column (purchase `effectivePurchaser` reads only requested parties' candidates). A `text` value
  holding a shortcode backs a branded `idMulti` filter.
- `{ predicate, reason }` is filter-only SQL passed the same way; `reason` says why it is not one row
  value. `predicate` names the descriptor kind it serves and receives that kind's parsed value: a
  trimmed string (`text`), `{ values, presence }` (`multiselect`/`idMulti`, with the declared
  `nullable`; `idMulti` adds `includeDescendants`), a boolean, a presence, or `{ from, to, presence,
  param }` (`range`). A value-filter predicate offers Exclude.
- `{ rollup, via }` is a count, total or extreme over related records: `{ rollup: "count", via:
  "expenses" }`, `{ rollup: "sum", via: "expenses.cost" }`, or `min`/`max` over a date or numeric
  terminal, with `absent` naming related stored fields that must be NULL. The generator checks the
  path leads through a list to an aggregatable field; the compiler builds a correlated aggregate over
  live rows at every step, and `sum` accumulates in `numeric` before casting. Repositories pass no
  SQL and read the same value through `declaredRollup`.

Predicates are the countable declared exception and only shrink: each is listed in
`apps/web/generator/entities/predicate-baseline.json`, and the generator rejects an unlisted
predicate and an entry whose predicate is gone. A predicate stays only when the filter value itself
defines membership (no value or row set exists apart from the request) or its replacement needs a
contract only that filter would use; computing outside SQL does not qualify, because prepared values
and row sets carry app-computed data. Removing one adds an integration test running the old SQL
beside the compiled filter over one synthetic fixture and comparing row ids (with any intended change
in its expected diff), and deletes the old SQL in the same PR. The remaining predicates:

| Predicate                                         | Why it stays                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| product, inventory `effectiveOwner`               | Values mix Ledger Party references with owner states (`@household`, `@unknown`), resolved in app code over every live entry (`inventory/repo/ownership.ts`). A row set would need a column holding a reference or a state, used by these two filters alone; the predicate receives the resolved id set. |
| project `dateRange`                               | The project's own dates overlap, or a dated task through its effective project, or an expense through its allocation shares: a deliberate non-recursive approximation (`dashboardProjectDateCondition`). It could become `anyOf` over a `dateInterval` and two row-set paths.                           |
| email `purchaseId`, `vendorId`, `vendorAccountId` | The value defines membership: each resolves one scope record (`singleValue`) whose evidence SQL decides which Emails belong and anchors `linkState`, and each is the filter a `derived`-provenance relation names.                                                                                      |

Email's `purchaseId`/`vendorId`/`vendorAccountId` declare `singleValue: { reason }` (`linkState` is
relative to one scope record): their schemas accept one value, pickers choose one record, and the
repository rejects more than one across the three.

A predicate and a value both receive the caller's quality read context (`where(filters, [], {
readContext })`); a value that reads it is `listReadValue(read => sql)` and renders the canonical
scalar without one. SQL needing request data (inventory valuations, an Email list's scope) wraps a
`listPrepare(load)` handle, whose `load` receives the request's filters, with `.value`/`.predicate`;
fields share a prepare by sharing the handle. `.value(render, { projection: "binding" })`, or
`projection: "binding"` on a plain SQL value, keeps SQL for filters, sorting and grouping while a
read binding supplies the projected value; projection alone does not run the prepare. Expense's page
binding supplies allocated category identity; Vendor brand spend uses one grouped read for selected
Vendor ids; live Product and Purchase primary-key joins keep each live Expense's contribution
singular, including refunds. Vendor Mail search uses the page's ids unless its query context already
holds global search states; sender-conflict attribution still checks every Vendor.
`scaffold.context(db, request)` loads each needed prepare at most once, only when the request
filters, sorts, groups or projects a field that reads it; a caller holding a prepare's data passes it
as `context(db, request, [[handle, data]])`. `where`/`orderBy`/`filterPredicates` stay synchronous
and take that context, `list` builds it unless `spec.context` passes one, and `hydrate` receives it.
The generated `generatedEntityListFields` map (`@cubby/schemas/entity-list-fields`) carries each
entity's derived shapes, row sets, term expanders, inherited fields, hierarchy, subtree toggles,
Group by choices and declared scopes; field presentation stays in each entity's web metadata slice.

### Hierarchy filters

An id filter (stored, `via`, or an `idMulti` predicate, by its `brandRef`) whose target declares
`model.hierarchy` matches the selected records and their live descendants through
`hierarchyDescendantsSql` (`server/generic/list/repo/hierarchy.ts`), the one recursive-descendant
generator, which repositories also call directly. The compiler adds a boolean `includeSub<Plural>`
toggle ("Include sub-…") per such filter; absent reads as on and `false` limits the filter to the
selected records. Declared exact references and related-view filters keep an exact default, where
`true` includes descendants; new exact relationships own separate `<filterKey>IncludeDescendants`
parameters so one relationship's mode cannot overwrite another's, and an id filter can declare
`subtreeParam` to own its mode independently. The compiled subtree binding owns the parameter key and
default; browser state uses explicit exact/subtree tokens only when overriding it, and URL codecs
round-trip the boolean under its own key. Ancestor section and Pivot drill-downs request
descendants; exact leaf sections request the record. Native keeps its existing filter controls until
it supports the explicit default fact. Examples: inventory `locationIdFilter` with
`includeSubLocations`; project's stored `parentProjectId` with `includeSubProjects`; expense's
allocated project and spending category predicates receive `includeDescendants`; a row-set terminal
(an image's import run) and an inherited reference (task project, a category's effective spending
category) get the toggle like any `via` path.

Include and exclude share the filter's hierarchy mode. Section exclusion is unavailable when it would
change the mode of an existing picked or excluded value; it never broadens or narrows other
selections implicitly. Shared section headers explain unavailable exclusions on focus or click, and
the member can choose the scope in Filters first. Row sets can match both Has and No value; switching
to Has cannot exclude their missing-value group.

### Declared lists over a relation

A list over a SQL relation rather than one entity table — the Work queue's union of Work sources,
each Suggestion family — declares itself with `defineRelationList`
(`packages/schemas/src/relation-list.ts`): filters (`text`, `multiselect`, `idMulti`, `boolean`,
`range`; a `text[]` column with `array: true` compiles to overlap), sorts, Group by choices, saved
views and page size ([ADR 0023](adr/0023-lists-are-declared-over-a-relation.md)). It derives the same
URL codec specs as an entity declaration (`<col>Exclude`, `<col>Presence`, range bounds, `@me`), a
strict typed input schema, and the compiler descriptors that `compileDeclaredFilters`
(`server/generic/list/repo/declared-filters.ts`) turns into Drizzle predicates over any column
resolver; entity lists compile through the same function. A web route derives its search schema with
`relationListSearch(list)`. A reference filter's options come from the generic entity roster; static
options live on the declaration.

### Row sets and same-row matching

`model.rows` names a to-many set of rows a `via` can start at. A row set is not an entity: it has no
shortcode, manifest entry or relation section, and its key may not repeat a relation or
`model.derived` key. `path` walks foreign-key edges (`compileTraversal`) to a child or shared table,
and `where` narrows by column equalities on the row table (product `barcodes` is `EntityExternalId`
rows with `source = 'gtin'`; soft-deleted rows never match). `json` reads a JSONB array of records on
the row (financial account `aliases`), whose item keys the generator checks against the read schema.
A path row set's table, `where` columns and terminals are checked when its SQL renders (`rowSetSql`
in `field-compiler.ts`). `repository` declares the columns of a relation the repository passes as
`listScaffold(entity, table, { readSchema, derived, rows })`, SQL selecting `"owner"` (the list row's
id) and each column, a `{ reference }` column holding a referenced id; the argument type is
generated, so a missing SQL fails typecheck. It compiles to an uncorrelated `id IN (SELECT "owner"
FROM relation WHERE …)` for filters and a correlated membership selection for grouping, rendered only
when read.

A relation may come from a `listPrepare` (`prepare.rows`): expense `allocationShares` bounds its
computed shares by the request's other row filters (`rowSetFilterKeys` names the keys to leave out)
and allocates only dimensions a filter or group reads (`rowSetIsGrouped`). Expense analytics, which
allocate shares themselves, drop the allocation filters their scope expresses and keep the group for
Match all and Exclude. Project `attentionItems` renders `VALUES` from the attention rules' items;
gardenEntry `journalPlantings` is SQL (live journal links, plus whole-area entries at a planting's
location inside its window). `relation` names a stored-path relation to an entity (product
`subjectTasks` over `tasks`, joining on the task's effective subject product), whose stored fields
are the row's columns. A related view's range column (product tasks by due date) leaves its presence
key to the view, so an undated task still counts. A row-set filter keeps a presence key it was
already published under (expense `projectPresenceFilter`); others get `<columnId>PresenceFilter`.

A repository reference column may opt into `entity_graph_read.connections` with `{ reference:
"financialTransaction", connection: true }`. Mark only the canonical direction (the row's `owner` is
the source); the reader exposes outgoing and incoming groups under `rows:<entity>.<rowSet>.<column>`.
The repository must register its scaffold before the request and supply static SQL; prepared row sets
are refused. Both endpoints must be live Entity rows with shortcodes. The reader deduplicates pairs
and computes the exact count and a deterministic bounded sample in SQL before hydrating labels. These
groups have role `reference` and disposition `null`; they add no stored edges and never enter
`ENTITY_EDGES`, lifecycle policy, orphan detection or graph traversal.

Every include filter through one row set matches the same row: the compiler builds one `EXISTS` for
the group, so account `source` Plaid with `externalAccountId` `ACME-0042` means one Plaid alias
holding that id. To match independently, declare a second row set over the same storage. Exclude
negates its own values independently: no row holds an excluded value, and a record with no rows
stays. Any value joins the shared row like a picked value (column not NULL; a reference live). No
value matches a row in the shared `EXISTS` whose column is NULL, or a record with no rows when every
condition in the group asks for No value. Match all gives each picked value its own `EXISTS`
carrying the group's other conditions.

A text filter over a row set may declare `terms: "<key>"`, an entry of `listTermExpanders`
(`server/generic/list/repo/terms.ts`) that turns the input into ORed contains-matches; product
`upcFilter` names `productCode`, every barcode encoding of the typed digits. The key union is
generated, so an undeclared or unused expander fails typecheck. The compiler moves `terms` off the
client descriptor.

### Declared list scopes

`presentation.list.scope` is a list's static row scope: stored fields pinned to NULL (ingredient
`["recipeId"]`: a recipe's own ingredient rows are never listed, searched or counted).
`scaffold.where` ANDs it into every list, count and Problems read (so `getEntityCounts` reads it
too). It shows no chip, and no request lifts it, `filters.ids` included.

`presentation.list.scopes` declares related scopes: a request key whose value is another entity's
list filter record, matched through `via`, a path or a row-set terminal leading to that entity. A
project page scopes its task list through `project` (the effective project, so subtasks that inherit
it match) and its expense list through `allocationShares.project` (any share). `projectScope` holds
the project list's own filter keys a project page sets (`status`, `kind`, `location`, `search`,
`dateFrom`/`dateTo`, `completionYear`, from `projectFiltersSchema`); its `search` matches as the
project list's does, and native filter state flattens it one level (`projectScopeKind`). The scope
compiles to `EXISTS` over the path to a record in the target scaffold's `matchingIds`. The repository
passes that scaffold as `listScaffold(entity, table, { readSchema, scopes: { projectScope: () =>
projectScaffold } })`, a thunk because the target's repository may import this one; the argument type
is generated. `scaffold.context` builds the target's context, and any row set the scope reads, only
when the request sets the scope. A scope is not a filter descriptor: no menu entry, chip, Exclude,
any-of, sort or group, and its key may not repeat a filter's. Expense analytics keep it beside their
allocation filters, since it selects whole expenses.

Audit change fields can name a declared relationship when recording reference lists (newly received
import records). Store UUID references; the generic audit reader resolves scalar foreign keys and
declared relationship arrays to public shortcodes, including tombstones.

## Background derived data

ADR 0025 replaces per-value admission with SQL views for read-computable values and one hourly
deterministic pass for stored results. A declaration names its compute adapter, typed result storage
and upstream `dependsOn` values; dependencies order phases and self-dependencies describe domain
hierarchies the computation handles. The data-quality and search capabilities declare their phases,
and `rebuildPhase` orders facts, quality, search and household diagnostics. A sink prepares outside
publication and commits its own typed storage with the coarse cursor. The hourly runtime reads only
entity declarations. Missing records create no placeholders.

### Views

Product service Cost reads its declared ProductCostView, so charge edits affect display, filters and
ordering immediately; it keeps the positive actual-charge selection, averaging, rounding and
latest-charge evidence, beside the positive charge total its explanation reads. Project effective
start reads ProjectStartDateView: an explicit start comes from the Project; otherwise the view reuses
the `rollups.dateWindow.derivedStart` fact on the hourly cadence (the derived side, so clearing an
override cannot reuse it). An unpublished rollup stays missing, not a successful empty date. The pass
skips declared views. View explanations compare the displayed decision, not the view query time, so
an unchanged live value is never reported as superseded.

### Stored results

Named read snapshots hold Product, Inventory, Location, Project, Expense, Email and Shipment results.
Each declaration names its typed value, decision, sort and publication-time columns; there is no
per-value execution row. SQL null without a publication time is missing; an explicit empty decision
is a successful empty result; a published SQL NULL becomes JSON null (a published empty Product price
stays empty rather than falling back to the authored price, while a missing publication uses the
declared field-resolution fallback). Typed decision columns store outcome metadata and provenance
beside the value without duplicating its payload; a compute may return a successful empty outcome,
omitting a record means no result, and publication rejects a value/outcome mismatch. Manual price and
Project start-date provenance are selected with their values in one statement. Current receipts never
relabel an older snapshot.

Product reads use typed `readFacts` for pricing and price eligibility, and `food` for food
summaries; reads never refresh them. Product stock is not stored: quantity ledger, expected
quantity, on-hand units, variance, placement, stock status, picker on-hand and ownership evidence
come from one live stock-facts batch per page (pickers, kit previews and purchase lines included),
so a member's own Expense, Inventory or Location write shows at once. List sorts, filters and
totals over expected quantity, variance, kit double-counting, disposal reconciliation and
unquantified lines compile the same rules as correlated SQL; disposal membership includes unlinked
Expenses. Owners and price keep the hourly lag. Recipe totals prepare bounded batches through a
shared costing context.

A stored result may declare `resultSchema` and supply several scalar fields through
`model.derived.<field>.fromResult: { key, path }`; generation checks each path and scalar type. These
fields share the result's publication, provenance and computation time; a null member is a
successful empty value and an absent member is unavailable. The list reader loads payloads in one
page batch and the compiler projects the same paths for sorting, filtering and totals. Generated
result schemas validate preparation and live comparison; a malformed page records a failure without
poisoning another target. Shipment event summaries keep timeline reconciliation and publish count,
dates, span and label together; list reads never reconcile observations.

A field can declare `storedProjection: true` with its `storedKey` when it cheaply folds a published
result with current context. Its raw reader supplies a private `storedProjectionVersions` witness;
the constructor accepts the projected value only when the witness matches the loaded result's
computation time, so a concurrent publication leaves the value unavailable rather than attaching
another revision's provenance. `storedPath` identifies the selected value. Embedded summaries carry
the witness from their nested SELECT (Meal's Recipe totals included); serialization removes it, and
it never reaches web, Apple or MCP. A field whose public name differs from its cache key declares
`storedKey`; the compiler requires a published stored value and the serializer carries that
snapshot's value and provenance together. Pure domain projections over selected envelopes use
`extensions.ports.fieldEnvelope`, invoked with already-loaded constructor inputs and performing no
reads; repository serializers and fact readers depend on `repositoryQueries` and pure presentation
modules, while media hydration and reset orchestration stay in the service layer. Product's port
projects physical Cost and unit prices from the selected price, even when price is not selected,
without a second price cache.

An own-table result stored on the entity row declares `recordSource` with payload and
publication-timestamp columns; the page reader takes both from the same row, and an optional
`freshAt` column may independently invalidate decision freshness. Recipe keeps `totalsPublishedAt`
through invalidation while nulling `totalsComputedAt`: browsing keeps the last totals, while strict
nutrition consumers require freshness; nested cost/calorie projections inherit that publication
identity without edit controls. Totals without a trustworthy publication time stay unavailable until
the pass replaces them. Direct nullable stored fields use the generic `storedPath` reader; an
explicit raw binding replaces it only for a required raw shape or contextual presentation, and two
explicit writers fail admission. Raw placeholders never establish publication availability.

An Inventory owner's current decisive assignment wins immediately; Product's owner collection is a
dependent fold that display and membership read from the same publication until the pass republishes
it. Inventory ownership publications capture resolved precedence steps with public party references;
older publications stay readable without steps, and explanations never rebuild historical steps.
Inventory detail reads, mutation read-backs and Product stock embeds use the published valuation
(unknown before first computation); only background compute and explicit live reports price rows
against current conversion graphs. Lists needing a value live (a one-hop lookup or a cheap indexed
rollup) compile it inline; the Location list's direct value is a live sum of stored valuations.

Email declares one typed `relationshipFacts` result: candidate discovery and retained/reviewed
evidence compute once per batch, and filters, sorts and hydration read them, while current Purchase
liveness, account ownership and the requested scope stay separate gates. Pair folding precedes scope
selection so replacement actions keep out-of-scope links; sender-proof Vendor inclusion is
independent. `importOutcome` folds selected accepted flags with the newest retained Mail import outcome
for the current checksum (an unresolved gap maps through `MAIL_IMPORT_GAP_OUTCOME`) and, only when
that holder recorded none, the holding Mail import Run (`importing` while active, `failed` once
ended); `importOutcomeDetail` adds the gap category, its executor, reason, awaited source and Run by
public code. Without published facts the outcome projects live. Negative boolean
filters require an available publication, so missing facts never match Unlinked. A member's Email link
or dismissal, and an automatic exact order link, republishes that Email's relationship snapshot inside
the decision transaction with the pass's compute and publisher. Before a page of Emails publishes, the
pass links their undecided exact order events, each in its own transaction, so older rows and Purchase
writers that do not link inline (removal, merge, reconciliation) converge within the hour.

Home and Work queue diagnostic sources read one hourly publication on the reserved household Project.
Canonical detectors, including private financial findings, run only in background preparation;
display reads fetch compact counts and status, and private finding arrays stay in SQL through
ownership fences, search, totals and pagination. Missing counts stay unavailable, stale or failed
publications keep their last successful findings, and current actions validate authoritative
evidence. The declaration names the physical graph, canonical source tables and quality/rollup
dependencies; new source tables must be read by the owning detector. Project attention still combines
stored rollups with current Task/Expense checks. Project dashboard cards read the same stored rollups
as the Project list, while portfolio totals keep live scope selection and allocation and the date
chips keep exact own-content predicates; they can differ briefly from a card's disclosed stale
snapshot and are neither a cache nor a settlement authority. Tool-ownership diagnostics load the date
policy alone. Scoped attention reads load only selected Project publications with complete subtree
totals; callers may select rule types (Project list filters and Work sources request their declared
rules), blocked-work checks still load the Task dependency graph, and unscoped Problems and dashboard
reports keep every rule.

### Hourly pass

`DerivedRebuild` holds one coarse pass cursor (target and last committed UUID), a single-writer
lease, cursor attempts, pass failures and the last three wall-clock durations. Each background
permit publishes one page: at most 50 identities, with adapters declaring a smaller
`preparationBatchSize` (default 20; the recipe ingredient graph stays at 20). Cursor-attempt
shrinking bounds a retry independently. Publication, cursor advancement, page counters and movement
time commit together. Reading ids and recording the page attempt share one CTE that commits before
compute; an enumeration error retries the unchanged cursor. Claims record attempts before compute, so
isolate terminations count: after three attempts the page halves, down to one record; three failed
attempts at one record skip it, keep its prior output and record a failure. A thrown compute or
publication fails only its page, keeps prior output and advances. A transient connection drop — a
killed statement, SQLSTATE 57P01, or a pool-slot timeout — retries that same cursor instead: the
release keeps incrementing cursor attempts and records the error, without incrementing failures, so
one drop does not mark the pass as failing. Repeated drops on that page reach the same shrinking
bound, which skips or fails the page with the error still visible. A provider outage costs one failed
call per bounded page.

The last three pass summaries keep processed-record and failed-page counts and duration.
`finishedAt` records completion even with errors; `cleanAt` advances only for a pass with no
failures. Interrupted passes resume their committed cursor across hour boundaries (five-minute
retries resume running passes); completed passes, failed ones included, wait for the next hourly
slot, and only a healthy pass clears failures. A requested new pass clears the previous error first;
a manual request never resets an active cursor. Queue continuations and the hourly timer enter the
shared background drain; an interrupted isolate's duplicate delivery waits out the lease. Worker logs
record each claimed invocation's target and yield or completion, without record ids or values. Drain
errors go to Sentry and schedule a retry without blocking purchase dispatch reconciliation. Search
publication uses a sorted upsert, retires missing documents in the same transaction, and re-marks
embeddings only for changed embeddable documents, keeping unchanged documents' failure backoff.
Recipe invalidation only marks totals stale; USDA release activation, selected image descriptions,
explicit search repair and image-search backfill converge through the same pass (backfill reports
zero publications until the pass writes output).

Activity checks committed cursor movement for two missed hourly periods or three failures; a
75-minute lag marks it behind without flapping at an hour. The maintenance rebuild command starts or
resumes the same Worker pass; its status query exposes aggregate progress and timings without
triggering work. Incomplete diagnostic sources omit their counts, so Work reports unavailable rather
than a partial healthy zero. AI responses and vectors are retained; the pass never waits for AI or
embedding regeneration. Source edits need no fences or generations: the next pass repairs mixed-age
reads and visits the full declared population, including relationships whose sources changed or
disappeared mid-pass. Own assignments and money/identity command validation stay immediate and live.

The caches are disposable. Overrides, explicit None, waivers and accepted Suggestions are inputs and
survive a rebuild; identity tombstones clear the declared snapshots. Integration journeys settle
`drainStoredDerived(db)` after edits before asserting stored lists, filters, totals or quality. The
synthetic corpus rebuilds every typed result, searchable entity, Product conversion coverage and
Recipe totals from retained inputs and compares semantic values and sort keys (excluding clocks and
cache ids) through real publishers with an offline USDA port; this is fixture evidence, not
production timing. SearchDocument, Recipe totals and ProductConversionCoverage keep their typed
storage; quality publishes to `QualitySnapshot` ([Data quality](#data-quality)).

### Membership and completeness

Reads never compute or repair. Lists compile a stored field to one primary-key lookup
(`storedDerivedSql`) for rows, sort, filter and footer totals, and a missing value reads as unknown,
never zero. Product ownership membership and cached boolean predicates keep SQL NULL for an
unavailable publication, distinct from a known false; ordinary WHERE reads select only true matches.
Contextual values and predicates declare `requiresResult` to bind membership to a stored result
(generation rejects a missing key); a predicate adapter returns NULL only while membership is
unresolved, so authoritative current decisions settle membership immediately. Row-set paths can bind
`requiresResult` too. Presence-none and exclusions use the same availability contract, and scalar
adapters distinguish published empty from missing by the result's availability. The compiler
evaluates certain and possible membership; exclusions negate the opposite bound, so an unresolved
include never becomes a known exclusion, and `unresolvedWhere` selects possible-but-not-certain
matches in SQL. Published unknown-attribution portions are known outcomes.

For a requested filter bound to a result, count reads report additional candidates in
`meta.unresolvedCount` while `meta.totalCount` stays the known count; uncounted pages defer both and
keep Show unresolved available. No extra membership count runs for filters without result
dependencies. `entity.list.resultMembership: "unresolved"` reads those candidates through the same
filters, sorting, paging and envelopes; the default `known` selects only certain matches, and
selection-id reads carry the same mode. The web status strip discloses an incomplete count and
switches modes, retiring the previous selection.

Declared totals can bind `requiresResults` to the results their contributions need. A missing
contribution or unresolved filter membership marks the sum keys in `meta.incompleteSums`; numeric
sums omit those keys and total labels call the available subtotal known and incomplete. The
full-filter aggregate checks missing publications and unknown membership in the same statement as its
sums; numeric-only total reads withhold incomplete keys; missing completeness metadata never
qualifies a subtotal as complete. Current authoritative numeric assignments settle a contribution
immediately; an old own result suppressed after reset cannot make it complete. When a sum and its
check reuse a numeric scalar, the aggregate reads it once per row through a one-row lateral
projection behind a planner barrier.

### Stored evidence and explanations

On-demand field explanations expose a stored root as `storedResult` in the source-dependency
projection; a manifest can bind evidence paths there while ordinary field paths project compact
values. The explanation reads the root and displayed envelope in one MVCC snapshot and labels live
recomputation as a separate, explicitly requested comparison. A popover supplies its displayed result
and scope; a superseded publication returns no substitute explanation; refresh updates record and
explanation together. Value, decision and captured facts describe the same computation; exception
controls stay separate. Evidence not captured in the publication is unavailable, never reconstructed
from current sources (Expense beneficiary portions use this to keep contributors out of list
payloads). Scalar publications keep their numeric/null shape and may capture private inputs as
`storedEvidence` in their decision metadata, removed in SQL from ordinary reads. Inventory valuation
captures the actual conversion graph including the unrounded price edge; Product price its weighted
cost and quantity operands (keeping PostgreSQL decimal rounding, never binary floating point);
USDA food its chosen lookup. Live Product stock fields explain from the current row's ledger and
inventory. A publication missing an
optional evidence path stays readable with available aggregate evidence but reports the explanation
unavailable; it never throws, reconstructs, or certifies partial capture. Opening an explanation
never computes missing service Cost evidence. Field explanations never publish a comparison; clients
show the publication time when known, format values with the field's formatter, and keep structured
evidence for non-scalar results.

## Runtime interface

All generic entity work enters through `executeEntity(context, command)` in
`apps/web/src/server/entity-kernel`. It owns:

- public-id and Zod validation;
- capability checks and normalized pagination and sorting;
- baseline get/list/create/update/bulkUpdate/delete/merge/search commands;
- declared attach/detach relation families;
- transaction-owned source-change registration, then post-commit object cleanup and best-effort
  queue wake-ups; paged background work refreshes projections, embeddings and derived results, with
  periodic repair for lost wake-ups;
- one normalized delete result with public references and affected-edge data.

Record metadata and canonical edit validation for ordinary record pages live under
`server/entity-kernel/metadata`. A declared `capabilities.resolve` needs no code: `resolveEntity`
serves it from `entity-kernel/resolve.ts`.

Repositories own database access, transactions, invariants and the exact mutation order; the kernel
owns the write transaction, and a repository writes through `ctx.db` and never opens a transaction on
another handle. Workflow services own operations that are not entity CRUD (expense splitting,
reconciliation, cookbook import, product enrichment); extensions delegate to them instead of
branching in the kernel. Delete-effect accounting keeps its repeatable-read snapshot; the delete
boundary makes bounded fresh-transaction retries on serialization failure, while a caller-owned
transaction or a committed delete's consumer failure propagates without replay. Snapshot-based
financial booking and classification reviews use the same boundary, keeping the submitted review
fingerprint across attempts.

Summary `entity.commands` writes request reference-only mutation projections. Trusted operation
receipts keep that summary; a later full replay reads the existing record without repeating the
write. Normal write bodies expose one final-output reader through `defineMutationWriter`; `asActor`
preserves it and `defineRepository` derives projected create/update readers. A declared writer
without that capability is refused when bindings load. Mandatory mutation snapshots and domain work
run before the final reader; requesting a reference skips only response hydration. Explicit
unchanged writes still register source changes, while unchanged inputs preserve review eligibility;
audited and explicit unchanged writes share one registration owner, with no kernel fallback based on
audit or capture counts. Publication fences lock and reread the authoritative target, declared
basis, direct references and backing rows. Each connection endpoint owns discovery for its own
snapshot; candidate evidence fences both endpoints before publication or apply.

Partial updates preserve omitted fields. Scalar patching rejects undeclared keys, skips unchanged
rows and audits changes in the same transaction; bulk mutations report every selected row. Alias
deduplication, tree invariants, relationship writes, import settlement, quantity reconciliation,
explicit receiving and deletion/merge transactions stay on registered domain owners. Specialized
renderers keep inline edits, quantity displays, relationship filters and computed facts; an unknown
renderer override fails rather than dropping a field. Semantic editing intents select fields once;
context-sensitive defaults, access rules, command transforms and editor blank handling stay
explicit, and canonical schemas validate the payloads. Domain wayfinding owns labels and entity
membership; the application-view catalog derives ordinary destinations from it and the entity
registry, while authored specialty destinations keep their order.

Generated operation rosters and primitive field enumeration do not establish behavior: exercise
shared compiler/runtime behavior with representative contracts and keep real database and browser
coverage for domain exceptions.

## Workflows

The fluent builder is the public graph-authoring interface; a bound workflow exposes the same
executable definition the inspector shows. Argument adapters supply context and input; application
decisions belong to named steps. A single repository transaction, provider operation or pure
computation that needs no graph sequencing is an ordinary registered function: it runs directly with
tracing and exposes its operation identity without a one-step graph. Repositories exclusively own
transactions; the runtime has no transaction adapters, transaction nodes or after-commit queues.

The runtime distinguishes reads, commits and required effects. Failure translation preserves
cancellation and effect-failure evidence. Required effects follow their commit, including when
cancellation arrives after the write. Ordinary recovery refuses new or ambiguously acknowledged
writes and is not retried recursively. Queue messages are wakeups, not durable jobs; handlers gate on
the row's own staleness marker (README "Background tasks").

Mapped and bulk workflows preserve input order and bounded concurrency. Started work settles before
failure, cancellation or early close is finalized; later windows are not prefetched. Finalization
receives every completed item even when its progress tick was not consumed, and an empty operation
keeps its completion metadata without inventing an item. The agent stream is a direct async
generator that acquires and unconditionally releases read-only tools, preserves event order and
forwards cancellation. Cookbook preparation feeds the shared bounded bulk executor; there is no
generic preparation framework. Import settlement keeps committed recipe receipts for final costing
and indexing. Background payload graphs expose revision checks, replacement dispatch, provider calls
and persistence; queue draining caches each batch-kind lookup once.

## Transports

Generic detail, list, deferred filter-option and write operations use one authenticated operation
dispatcher and generated entity-to-input/output maps. Specialized shapes such as Image and USDA Food
are ordinary operations in `server/domains/<domain>/operations*`, sharing authentication,
validation, errors, cancellation checkpoints, tracing and console observability.

Operations that are not entity CRUD have one path: a contract in `src/contracts/`, implemented once
in the owning domain's operations module (`src/server/domains/<domain>/operations.server.ts`, or
`operations/*.server.ts`) with `implementOperationDomain(contract, handlers)`, calling repositories.
The browser client, HTTP API and MCP are adapters over that implementation and hold no business
logic; there is no per-transport `*-browser.server.ts` module. Removing an operation has no
deployment shim: a tab loaded before the deployment must reload before calling it.

Browser calls POST the same plain JSON operation envelope Apple uses to
`/api/operations/<operation>`, marked `x-cubby-surface: browser`. Concurrent reads share a
`/api/operations/batch~<operation>,<operation>` request and stream results independently. URLs
contain registered operation names, never input values; the server rejects a path/body mismatch. The
Worker routes these paths directly to the dispatcher without loading the React server handler; SSR
invokes the dispatcher in-process. Every operation runs the Apple version gate on its principal, so
an outdated hosted WebView keeps its reads and cannot write. This transport keeps query coalescing
and independent settlement, which the framework server-function transport lacks across operations.

All query requests share the concurrency limit, including singleton reads and items retried after a
broken batch stream. Only recognized transient database failures receive bounded backoff; mutations
are never replayed. Terminal failures include preceding failed attempts and their diagnostics.

The dispatcher measures selected-handler loading in `start.dispatch.load.<operation>` before the
execution span; include that load and Worker startup when attributing cold latency. Deployed Worker
timers advance only after I/O, so module initialization can appear as zero-duration loading charged
to the next I/O interval, and a long query span does not prove slow database execution (see
[Cloudflare's timer contract](https://developers.cloudflare.com/workers/runtime-apis/performance/)).
Compare matching platform profiles and origin evidence; label local profiles separately from
production. Focused Problems reads dispatch through their canonical source before loading entity
readers or unrelated diagnostics.

The operation boundary chooses the read policy before invoking its handler.
`apps/web/src/server/db/read-policy.ts` owns it: interactive display operations use the bounded-stale
binding, subject to the member's read-your-writes marker; authentication, financial decisions and
mutation authority keep strong reads; no read performs a freshness RPC
([read consistency](../apps/web/docs/web-runtime.md#read-consistency)). Specialized
snapshot/external-service readers select their own sources; transport methods never determine policy.

The MCP surface is generated from `capability` contract members plus the entity-kernel verbs declared
in `apps/web/src/contracts/mcp-tools.ts` ([MCP exposure](agents/mcp.md#exposure)). `pnpm generate`
requires every action's handler and splits a group mixing queries and mutations, so read-only tools
stay auto-approvable. MCP invokes `executeEntity` through the kernel verbs of the `entity` (writes)
and `entity_read` (reads) tools and publishes their contract at `entities://catalog`. `entity_read.resolve`
reads Products and Vendors and never creates; `entity.resolve` resolves or creates Ingredients and
Plants. MCP, jobs, repositories, entity modules and kernel tests must not import browser transport
modules; operation adapters and typed Start streams are the only transport seams.

## Browser cache policy

Contracts (`apps/web/src/contracts/*.contract.ts`) carry browser cache policy as data: a query's
`cache: { tags?, profile? }` and a mutation's `invalidates: RippleKey[]`. Tags default to `[domain,
member]`, so a member declares them only when they differ (`tags: []` opts out). `invalidates` names
rows of the fan-out table in `integrations/tanstack-query/cache-tags.ts`; an empty list is a
deliberate no-op. `profile` is `browse` (default) or `live-status`
([change notifications](../apps/web/docs/web-runtime.md#change-notifications)). The fan-out table
stays until notifications carry rollup consumers: generated read dependents do not yet name the
Vendor, Purchase, Project or calendar rollups an Expense write moves. The vocabulary types live in
`contracts/cache-policy.ts`; no contract holds React, query-client or input-dependent code.

Browser call sites import one generated module per contract from
`integrations/tanstack-query/generated/domains/`, so a route bundles only the contracts it uses.
`defineOperationDomain` computes default tags and ripples from contract data, then applies optional
input-dependent policies from `operation-overrides/<domain>.ts`. Module initialization rejects
invalid policy and unknown override members. Domains stay independently loadable; cache-tag rosters
read generated entity keys and image policy directly.

Workflow-command metadata lives on the operation registry: rendering reads it without initializing
descriptors, and execution loads the selected domain lazily and validates input with its contract
schema. Handler tables carry module paths and export names; the typed handler runtime owns lazy
imports. MCP binding composition lives in typed source over generated tool/action data. Deferred
specialized actions use `useDeferredActionMutation`: the inner TanStack mutation keeps operation
metadata, key, scope and retry ownership; the outer one supplies loading state and presentation.

## Child storage

An entity's `children` declares its physical child tables with `defineChildTable`
(`entity-definitions/child-definition.ts`). Family modules in `packages/schemas/src/child-tables`
own columns, branded types, SQL defaults, update callbacks, indexes, checks, foreign-key actions and
Drizzle relations. Child storage acquires no entity identity, shortcode, client manifest or automatic
indexes. SQL constraint expressions use `{columnKey}` placeholders validated against the child's
columns. A column's `generated` SQL uses the same placeholders and emits a stored PostgreSQL
generated column (no default or update callback); retained mail stores text presence this way, so
Email quality reads a scalar instead of decompressing bodies. Child bigint columns can declare
`bigintMode: "bigint"` for exact money; the checked money owner converts only at public dollar
boundaries, raw verification sets keep bigints as integer strings, and SQL dollar reads use
`minorToDollarsSql`.

Mail, transaction-import and image-processing storage belongs to the module registry
(`child-tables/modules.ts`) because those rows are not owned by one entity. Both registries generate
definitions in `entity-table-definitions.gen.ts` and relations in `entity-tables.gen.ts`, exposed
through `server/db/schema.ts`; `image-processing-schema.ts` remains a re-export. Shared
infrastructure stays hand-written only where `child-tables/retained.ts` records an ownership reason;
generation checks the schema AST against that shrink-only baseline, and a new hand-written `pgTable`
requires declaration storage. Moving storage into declarations must preserve the Drizzle catalog and
emit no migration.

Before retiring any stored table, column or workflow, recheck its current readers and usage: empty
queues and null values alone do not prove a contract unnecessary. `MailboxCursor` backs Gmail
pagination and replay and must be preserved; `ImportPreparedOrder` and `ImportPreparedLine` are
active contracts.

Child read consumers opt into the shared list workbench explicitly with their scoped query, stable
read handle, navigation and named workflow commands; physical storage does not opt them in.
Suggestions use immutable Suggestion handles, so republishing evidence replaces review identity.
SourceTransactionRecord and TransactionImport are manifest entities with shortcodes and generic
reads; their intake stays workflow-owned. Run findings and photo reviews keep parent-scoped commands
and specialized editors. Photo review's selected-Product evidence read supplies canonical notes,
tags, category and structured identifiers beside purchase and image evidence; comparison panels
share it, and category summaries are bounded to the selected Products.

## Data quality

`capabilities.dataQuality` (`entityDataQualityMetadataSchema` in `definition.ts`) declares
`checks[{id, facet, kind, weight, scoreCap?, label, satisfiedLabel, message, placement}]`,
`exceptions` (true where the entity may record `DataException` rows), `related` (other scored
entities whose gaps roll up into this one) and `listOrder`. `id` is globally unique (it doubles as the
`dataGap` filter value). `satisfiedLabel` describes a passed check positively; `label` stays the
gap/filter label. `placement` names one owning `{field}` or `{section}` for contextual web results
(null uses the unplaced fallback); the compiler checks that field owners render in a detail fields
section and section owners exist. Placement changes presentation only.

The compiler (`apps/web/generator/entities/data-quality.ts`) synthesizes two model fields
(`dataQuality`, `dataGaps`) with the `data-quality` list renderer, the `dataStatus`/`dataGap` filter
descriptors and a `dataQuality` sort entry sharing the column id, so the "Data quality" header sorts
by score. **Declaration wins**: hand-spelling `dataQuality`, `dataGaps` or a `dataQuality` sort field
anywhere else in the manifest is a compile error — the block is the single source, as `filters.audit`
owns `createdAt`/`updatedAt`. A cross-entity pass enforces check-id uniqueness and turns each
`related` entity's check ids into `dataGap` options on the rolling-up entity. The generated leaf
(`packages/schemas/src/generated/data-quality-checks.gen.ts`) exports `dataCheck`,
`dataChecksByEntity`, the per-check facet/kind/weight/label/message maps, `dataCheckPresentation`,
`dataQualityFacets`, `relatedDataQualityEntities`, `dataQualityExceptionEntities` and
`scoredEntities`; `data-quality.ts` composes the public schema from it.

### Stored checks

Every scored repository declares one `defineStoredEntityChecks` entry in `read.quality`
(`generic/data-quality/repo/stored-registry.ts`): a versioned TypeScript evaluator whose single batch
loader produces records consumed by pure `qualityCheck` builders (`required`, `observed`,
`hasRelated`, `hasImage`, `when`). Its type requires one function per declared check
(`generic/data-quality/repo/checks/<entity>.ts`, typechecked against the generated check union).
Declarations in `packages/schemas` own check identity, weighting and placement. A record's quality
is the list of its unresolved checks; `data-quality-score.ts` owns the status derived from them.
`qualityCheck.records(entity, table, columns)` owns ordinary loader identity, liveness, bounded ids
and display-image presence; checks with joins or aggregates keep entity-specific loaders. Checks
perform no I/O. Related-row facts load once per id page; soft-deleted Recipes, Ingredients, Products,
Purchases, attachments and Images never count. Cookbook covers, Vendor logos and Location description
prerequisites use the shared displayability predicate. Meal cost completeness reads recipe totals and
Location descriptions read AI analyses as declared inputs. Immutable scored entities without soft
deletion use the same evaluator with no tombstone predicate.

Stored quality is the `dataQuality` derived value ([background derived data](#background-derived-data))
published to `QualitySnapshot`: the rules version and each check's pass, gap, waived or
not_applicable state. Entity has no quality columns. The `dataQuality` sort counts `gap` states at
read time (ascending is most missing first; unassessed sorts last). Hydration consumes named check
states for published and live evaluations alike. Quality consumers use `storedEntryFor` in
`entries.ts` as the single erased-table registry accessor. Lists, filters, missing-count sorts and
related rollups consume published outcomes; a missing publication is unassessed. `loadDataQualities`
defaults to live evaluation for record and detail reads; list pages and Work queue population reads
pass `"stored"`. A single-record Work strip evaluates that record live and reuses it for gap
admission, messages and counts without publishing a repair. Lazy explanations read the displayed
publication's captured facts. SQL predicates (`generic/data-quality/repo/sql.ts`) are closed per-row
primary-key lookups on `EntityQualityCheck`/`EntityQuality`, valid under any FROM clause (footer sums,
custom FROMs, Work queue branches), and derive the same status as the TypeScript core. `sql.ts`
builds every predicate as one parenthesized group so callers can embed it under `NOT` or beside `OR`;
the unit test asserts the shape. `related` roll-ups add an `EXISTS` against an aliased related table
reading its published states; `generic/list/repo/list.ts` binds the filters and sort for every scored
list in one place. Every research gap source uses `gapPublicationRead` to join its quality publication
once by entity id, kind and key, keeping missing-publication and fresh record-read semantics, related
rollups and complete reason membership under negative filters.

Each scored entity's `dataQuality` block declares the rows its evaluator reads beyond its own row;
waivers, attachments and attached images' integrity are inputs of every scored entity. Writes enroll
quality through transactional source registration; the hourly pass revisits the full declared
population, so a rules-version change republishes every record without a migration and catches
undeclared reads. Old publications stay readable until republished. Tombstoning removes stored
quality. Reads never repair it. Exception mutation responses evaluate the saved decision live
without publishing. Compact entity facts, including board cards, use the shared quality value and
lazy explanation, never a field count.

Blank text uses the ECMAScript whitespace set owned by `apps/web/src/lib/text-whitespace.ts`; stored
checks and SQL blank tests compile that set (tabs, nonbreaking spaces, Unicode separators; a
zero-width space is content). Rule versions invalidate affected publications. The generic SQL helper
also owns trimming for grouping keys, graph label fallbacks and Brand matching; merchant/title
canonicalization is separate.

### Scores and exceptions

Each check yields pass, gap, waived or not applicable. The score is `100 × satisfied expected
weight / expected weight`, limited by the lowest `scoreCap` of an applicable unresolved check; a cap
also applies to an unscored integrity diagnostic, so supporting evidence never turns a known defect
into perfect quality. Any unresolved check caps at 99, so rounding never shows 100 with a gap. Caps
and importance weights belong in the declaration; applicability and validity stay in check
functions. No applicable weighted evidence and no active cap produces a null score, **Not assessed**,
never an automatic 100; SQL sorts unassessed last in either direction. Active exceptions count as
accepted evidence, but an otherwise complete record is **Complete with exceptions**, distinct from
full evidence. Every weighted missing check must be closable through supported data entry or an
allowed exception; optional planning fields and inactivity are not completeness requirements. Actual
zero or negative costs are valid. Core identity, classification, usable evidence and financial
consistency outweigh optional imagery and descriptions. Explanations name deductions and caps.
Related gaps stay separate from the owner's score and never propagate through recursive chains.

Scored entities receive a shared, unscored display-image check by default; an evidence-only
declaration can set `displayImage: false` (Shipment does). Without a usable direct or declared
related image the check lists as missing and cannot be waived; it uses the thumbnail resolver's
presence predicate, so deleted images, PDFs, failed renders and unavailable files never qualify.
Entities without applicable weighted checks stay unassessed when it passes; an absent image supplies
the 99 cap.

A waiver (`DataException`, via `data_exception.set_exception`/`clear_exception`) records entity,
check, reason and note, keyed by an `Entity(id, kind)` FK, for entities whose declaration sets
`exceptions`. It turns that gap into `waived` until a member clears it; input changes, passing checks
and commodity toggles never reopen it. Enabling exceptions requires an allowed-reason list per check
(`EXCEPTION_REASONS` in `generic/data-quality/repo/exception-reasons.ts`, exposed as
`exceptionReasons`). An exception goes with its entity when the entity is removed or merged away.
Recording a finding requires a nonblank explanation of what was checked and found, with source
references where available; notes render Markdown source links on web and Apple, and controls never
substitute the reason label for it. Clearing removes the finding and reopens the gap without blocking
a later source-backed finding.

Reference read surfaces display effective resolution while editors keep the stored baseline. Quality
cells keep their semantic null state in phone cards (`mobile.showWhenEmpty`), so Not assessed is
visible. Named reference pills use the target's projected name; provenance naming a different source
never supplies a mismatched label. Allocated references share the `<stem>Allocations` projection with
`<stem>Id`, `<stem>Name`, `amount` and `incomplete`; the generic reference reader renders distinct
targets and unresolved-share indicators in lists, embedded tables and details (details keep amounts).
Do not create another entity-specific category column or allocation renderer.

### Entity rules

**Product** (rules version 1). One loader reads a bounded id page's identity, category liveness,
inventory, acquisition, external identifier, orphan-retention and displayability facts, then
delegates one batched price read to `loadProductPricing`. Kit-pricing rules stay authoritative: zero
is known, ancestors contribute weighted acquisition prices, misc buckets and services (category
feature service) have no price expectation, services have no identifier expectation, and unstocked
historical Products are never charged a missing price. Core identity checks apply to every catalog
record: name and known price weigh 3, Brand and identifier evidence 2, category 3 with an unresolved
cap of 69. Any non-null Brand, including Generic / Unbranded, satisfies Brand presence. One nonblank
model or live nonblank external identifier of any source and kind satisfies identifier evidence;
missing both is one Identifier gap. The check keeps the key `product_external_id` so accepted
exceptions keep their basis; model-only exceptions do not establish an external identifier's
absence. A known explicit or derived price, zero included, earns credit; an unknown price is required
only for stocked Products outside misc buckets. Catalog inactivity is an unscored diagnostic. A
Product's `commodity` flag marks interchangeable goods with no single listing and removes brand,
Identifier and ASIN checks; it is a member decision, never inferred from an unknown or Generic Brand.
Lists, dataStatus/dataGap filters, score sorts, Research views, related Purchase rollups and Work
research branches read the published value; non-quality price-presence views (including optional
misc bucket valuations) read the canonical price SQL and its availability, never quality
applicability or `readFacts.workFacts.priced`. Product, Expense, inventory, brand/vendor, category,
kit link and attachment rows are declared inputs; image integrity reaches attached Products through a
join path, and a kit's acquisition lines reach its components.

**Email** (rules version 2). One loader reads only its id page's classification, retained-text and
attachment presence, current preview, accepted/link evidence and completed same-member Mail import
membership; bodies are never selected. Automated relevance decisions are final: no check asks for
member review, and a linked or imported Email is never undecided. Checks keep current-checksum
preview rules, live Purchase/account ownership fences and JSON source containment (historical source
JSON allows extra fields, excludes missing keys and malformed arrays, and distinguishes explicit
null). The completed-import check matches a live completed Mail import Run of the same member with
the original in its source list. List facets, score sorts and the Email Work branch read stored
outcomes; no mailbox-wide relation runs on those reads. The Email Work branch routes rows by gap:
undecided relevance is member work, a missing original agent work, and import and preview gaps close
through Mail import. An Email without a publication stays possible member work, reported as
unassessed. Gap counts read only currently declared checks. Bulk Email review checks read
`EmailReview` for the current checksum and owner: only member labels count, the latest wins, and a
correct verdict without a correction stored the prediction's classification.

Email `status` is `pending`, `researching`, `completed`, `unsettled`, `deleted` or `excluded`. An
`unsettled` related Email that an import attempt left without accepted or linked evidence keeps its
holder Run and is readmitted only by a new evidence revision (ADR 0011). Storage-only `orderKeys` and
`trackingKeys` hold the normalized order and tracking numbers its content prints, valid for
`mailKeysChecksum`; ingest writes them and the import claim recomputes missing or stale keys; they
are exact-linking inputs, not read fields. Storage-only `importAttempts` counts admissions at one
evidence revision (checksum plus the admitting Run's recheck revision), bounding re-admission at
three.

Email metadata, original/attachment persistence, candidate/classification observations,
`EmailReview`, `EmailPurchaseDecision`, linked Purchase writes and Mail import Run/source-roster
changes enroll quality transactionally; Run source changes enroll quality even when other families
ignore Run execution metadata, while progress-only projections enroll nothing. Email metadata
persistence registers source intent only when it creates an Email, changes stored metadata, or
excludes a pending eligible legacy copy of the same message; a replay doing none of those leaves the
Email and refresh Job tuples unchanged. Explicit member search renews acquisition expiry and
registers source intent. This never reclassifies evidence, resolves historical ownership or replaces
member decisions; member waivers survive evidence changes.

**Expense** (rules version 1). One page-scoped loader reads scalar fields, shared allocation and
category completeness, product-expectation policy and display-image presence; SQL helpers keep
sibling allocation weights, inherited Purchase/Project/category precedence, liveness and rounding.
Checks keep incurred-only cost/category/quantity rules, known zero costs and product expectations on
planned merchandise. Problems detectors have no direct Expense quality predicate. Expense, Purchase,
Project, vendor and category edits enroll broad quality intent through audit registration;
allocation/settlement links and attachments use their source-change registrations. The family scans
current Expenses, including descendants affected by inherited inputs, without mutation-time
traversal.

**Purchase** (rules version 1). One loader scopes Expense and settlement-allocation aggregates to the
id page, reusing the evidence and settlement policy owners. Paperwork compares vendor lines only
(planned included); settlement compares every incurred Expense (reimbursements included) with posted
or outstanding evidence. Known zero costs, cent tolerance and posted-refund explanations are kept.
Lists, filters, sorts, Research and reconciliation Work branches, Problems membership and related
Product rollups read published rows; detail reconciliation shows current money and evidence.
Purchase, Expense, vendor and attachment rows are declared inputs; settlement evidence no column path
reaches converges through hourly reconciliation. All Purchase waivers (paperwork, settlement amount,
party and tender) stay until cleared.

**FinancialAccount, FinancialTransaction, Run and Task** (rules version 1). Each loader scopes reads
to one id page. FinancialTransaction reuses the signed allocation and Purchase evidence owners; Task
reuses declared trade inheritance and checks its date window; FinancialAccount keeps cash
self-evidence, source aliases and live settlement references as claim evidence. Published rows own
list filters and sorts; record reads evaluate live. Audited financial, account and task writes and
source-record import changes enroll quality transactionally. Run creation, terminal step transitions
and photo completion register source changes; step progress stays projection metadata, and
derived-refresh Run telemetry registers projection changes so a pass cannot invalidate itself.

**Run** uses the shared score, filters, sorting and explanation; its list includes quality and media
in one page request. Checks assess recorded actor attribution, a consistent timeline, and terminal
target outcomes for completed Mail import and photo inventory runs (and historical validation and
enrichment runs). A skipped or unavailable target needs a recorded reason; running or paused work
needs no finished targets; execution status stays separate from quality. Browser captures are
required by their commit contract, not universal Run quality. Image jobs (`imageJob`) are an unscored
entity. Scored and unscored web renderer coverage is type-checked against the generated list shape.

**Shipment** is a stored-quality kind with `displayImage: false`. Quality requires a known
incoming/outgoing purpose and a resolved Purchase association (a live Purchase link, or a
member-reviewed null association for a non-purchase shipment; a reviewed link to a deleted Purchase
fails); each unresolved part lists as its own check beside tracking evidence. Purchase/Expense quality
owns itemization and Product completeness. Its loader reconciles current observations once, sharing
`reconcileShipmentTimeline`, `shipmentEventSummary` and `shipmentMilestones` with the tracking
report. Chronology follows `shipmentMilestones`: conflicting exact delivery times and reversed exact
possession/delivery milestones are defects; coarse calendar-day intervals and other movement kinds
establish none, and missing or coarse timing affects only dates/span checks. Observations distinguish
stated event dates, date-only notification fallbacks and estimates with `timeBasis`; missing
provenance stays unknown and retained extraction JSON is never rewritten. First/last dates and event
counts include dated observations (forecasts included); quality evaluates the non-estimate timeline,
and notification dates cannot establish exact elapsed milestones. Timeline readback exposes revision
successors and each supporting capture's source identity without copying bodies; an unchanged
observation keeps its original attribution when a refreshed capture adds support.

**Vendor and Vendor Account.** A Vendor Account has no stored or editable name: its title is always
`<Vendor> · <member>` from current parent names (`vendorAccountLabelSql` in `server/db/computed/`),
shared by reads, search and sort, reference lookups, Run labels, filter options and the entity
graph. Every Purchase expects a Vendor Account; a missing one is an identity gap in the Purchase's
Research queue, while attribution stays nullable. Account purchase previews follow that link (three
newest live purchases and the full count). Vendor Accounts have no quality score until they have
actionable checks; no checks does not mean 100. Every live Vendor expects a displayable logo,
including Vendors without purchases or accounts; the gap appears once in the Work queue as shared
Research work, and an `unavailable` waiver closes it. Order-evidence and website checks keep their
purchase-based applicability.

### Research and Work queue

The Research queue ([terminology](guide/terminology.md#purchase-research)) is no table: it is the
`research-queue` saved views on Product, Purchase, Expense and Vendor, filtering `dataGaps` to the
checks research can close, sorted by `dataQuality` ascending. A `DataException` closes a gap until
cleared.

The `/work-queue` page composes those predicates with Problems, Email attention, findings,
Suggestions and account work as Work sources ([work queue](guide/work-queue.md)). Each domain exports
its sources from `server/domains/<domain>/repo/work-sources.ts`; `server/domains/work` composes them
explicitly (ADR 0019 forbids a registry), and `server/generic/work-queue` imports no domain module. A
source's candidate select projects the shared row shape through `selectWorkCandidates` (`source`,
`entity`, `id`, `name`, `key`, `family`, `executor`, `reason`, `reason_keys`, `owners`, `shared`,
`amount`, `date`), deduplicating shared CTEs by name. This is a read projection, not an entity or
assignment ledger. An MCP read fences to shared work and work owned only by the connected member
before counts and paging; the household UI's Owner filter grants no private access.

Household web reads (`workQueue.queue`) read the published `WorkItem` rows: the full source union
with deferrals applied and owners routed (member codes, section key and label), replaced in one
transaction by `publishWorkItems`. Filters, search, sorts, Group by, view counts, summaries and
hydration run over that relation. `WorkPublication` records the snapshot instant, the last unread
member write (`dirtyAt`, set after commit by `recordChange` in a request or member-awaited background
write), and the last failed attempt with its raw error, which holds off the next attempt for a
minute. Publishers take a transaction try-lock, so one runs at a time; readers never wait and keep
the previous rows until a publication commits. The insert runs in a savepoint so the lock holder
records its own failure. A published read returns `meta.publication` (`publishedAt`, and the latest
failed attempt's raw error); the last good rows keep serving. A missing publication is written before
the first read; a first read that cannot publish fails with the raw publication error (SQLSTATE and
Postgres message first) rather than serving unpublished zero work. A stale publication (dirty, or
older than two minutes) is replaced after the response, and its commit rings `workQueue` readers.
MCP reads and `workQueue.forRecord` stay live. Publication captures coverage messages and incomplete
Project/diagnostic inputs with the rows. A source declared `admittedReasonsOnly` (pending suggestion
families) stores each record's full membership; the read keeps only admitted reasons and drops a
record with none, so a Product with a field suggestion and a product-pair review stays in Needs you
as the pair.

`workQueueList` is the queue's [relation list](#declared-lists-over-a-relation): Type, Owner,
Family, Executor and Reason filter and group it; Date and Amount carry unsupported reasons. Group
keys are filter values with absent values last; Owner sections have no exact filter because a
member's filter also matches shared work. Saved views (Automatic, Agent, Review, Waiting, Problems)
are `{key, label, filters}` (ADR 0022); view counts are computed before the active view applies. A
zero-page-size read returns no rows and supplies full-filter Reason × Type cells plus distinct Type
margins in `meta.summary`: reasons use all memberships, duplicate keys in one item count once, and
the grand total and Type margins count each item once. Summary and Pivot reuse the same eligibility,
routing, member fence, deferrals and completeness metadata as Records. An active Reason filter limits
the summarized keys so a drill-down cannot widen the population. The engine prunes sources a reason
filter or record scope cannot admit; the filtered population materializes once for the view, totals
and counts; filter and stable sort precede LIMIT/OFFSET; quality gaps and display images hydrate for
the page only.

Research and Email rows carry structured `gaps` (`{check, message}`): the record's live gaps among
the checks its saved view declares (`workQueueGapChecks`); other rows carry none and keep their
`reason` text, and a gap row's `reason` is its messages as sentences. The `check` filter narrows each
gap view's predicate inside the branch, and branches that cannot carry those checks drop out, so
counts and pages agree. Rows carry the record's own `amount` (a Purchase's `SUM(Expense.cost)`, an
Expense's cost, a transaction's signed amount), `date` and `vendor`, declared once per entity and
reused by findings naming the record; they sort and filter server-side with nulls last. Queue-entry
age is not offered. `workQueue.forRecord` (household web only) pushes an exact record filter into
every branch, skips field-level suggestion groups and record-less diagnostics, and keeps routing; the
detail page and inspector render a compact Work strip, or nothing. Image descriptions are read and
confirmed on the Image processing panel and produce no Suggestion Work rows.

Every source excludes Purchases dated after the current household day and Purchases whose live
Expense lines are all `future` (Purchase has no stored `future` flag; deleted lines do not count;
mixed lines stay eligible; an undated Purchase without lines is unknown, not planned). The
record-detail queue applies the same exclusion. Run attention candidates join their current member
and source account once; they share one authority expression with scalar Run-finding lookups (the
live member/login and current source owner must agree), and a missing or deleted source account stays
unresolved, never falling back to the actor or becoming shared work. Project attention reads Task
dependency state through the actionable Task list's blocker resolver in five narrow graph queries,
excluding checklist rows from results while keeping them in the graph.

Finding eligibility requires stored status `open` and no expiry or one strictly after the
evaluation instant; Problems and Work reads filter that without changing stored status. Explicit
Apply checks expiry before changing business records; expired findings stay visible in Run history,
can be dismissed, and offer no Apply. Every Run purpose exposes findings and dismissal on the Run
detail, photo inventory included. An already-applied idempotent reconciliation stays governed by its
receipt. The retained open-evidence unique key depends on stored status, not expiry: a writer
introducing deadlines must dismiss an expired holder of the same evidence key inside its write
transaction before inserting fresh evidence; reads never perform that transition.

Entity-predicate, diagnostic-backed and transaction-import account branches share the bounded
Problems scheduler with four concurrent tasks: entity branches first in declaration order, then
diagnostics, then account work. Project attention is one request-local promise shared by entity
predicates and diagnostics; its subtree snapshot also supplies date windows to tool-ownership
diagnostics. A failed branch rejects the read rather than returning an incomplete queue.

The browser reuses shared infinite loading, column controls, checkbox selection, Copy codes and
responsive inspection. Queue keys identify work reasons; source shortcodes identify records and are
deduplicated when copied; rows without source codes are not selectable. Filters clear selection,
scrolling preserves it, and refetches reconcile it. Select-all-matching uses the shared bounded
pager. Projected fields sort before paging with stable name/key ties; the Reason column is
unsortable and shows one chip per failed check (label from the declaration, message as tooltip and
accessible text), filterable by check. Filters and sorting are URL state; browser pagination keys are
dropped and unsupported sort fields fall back to the default; column controls are session state. MCP
keeps its paged contract. Run rows open passive Problems.

## Relations, deletion, and merge

### Relationship authorship

Relationship authorship uses `entity-definitions/relationships.ts`. A stored singular identifier
reference uses `r.field(key)`; its field owns the target used by storage, validation and the graph,
and ordinary storage entries inherit it (explicit null opts out). `r.link(kind, direction)` and
`r.query(key, cardinality, reverse?)` inherit endpoints from their kind/query owners. `.named(key,
label, options)` supplies presentation and explicit mutation policy; `.source(key, label)` adds a
named evidence source. Traversable handles derive inverses mechanically, and `.through(next)`
requires compatible endpoints. `r.path(target, cardinality, steps)` checks edge keys, direction,
adjacency and the final entity against field and child-storage declarations. The type-only
`relationship-catalog.ts` assembles these definitions from the bootstrap's automatically discovered
`definition-catalog.gen.ts`, with no manual entity roster; generation still verifies the complete
physical catalog and semantic policies.

Derived filters and external references stay explicit read handles; browsing membership never
grants write, detach or cascade authority. Query-backed sources name a read-only association in
`relationship-query-definitions.ts`; `relationship-query.ts` owns its SQL. The shared traversal
compiler follows these sources in either direction at any supported depth, storing no second graph.
Query sources distinguish retained history from current references. Expensive association queries
enumerate a bounded candidate relation before joining targets; Purchase Email discovery never runs
acceptance policy for every unrelated mailbox record.

A relationship may add more named sources. `Purchase.products` combines detachable `explicit`
evidence from `purchaseProduct` links with non-detachable `expense` evidence from every live
product-linked Expense (exits, adjustments, unknown quantities and planned lines included). Counts,
filters, inverse navigation and traversal use the same deduplicated union; curated previews and
filters expand every named source through the shared path compiler (MealFoodEntry and served
MealRecipePortion evidence included), never only the primary source. Movement roles and planned
status are backend evidence. An unconfirmed explicit-only link is Linked and establishes no
acquisition or ownership. Explicit acquisition confirmation (`EntityLink.acquisitionConfirmed`, only
on `purchaseProduct`) establishes Acquired with unknown item cost and quantity and creates no
Expense or inventory. Foreign receipt items use ordinary Expense acquisitions with supported quantity
and unknown USD cost beside the booked USD aggregate; source-line references own replay identity,
Product corrections and merges use the Expense, and unpriced acquisitions contribute nothing to USD
pricing averages ([foreign receipt itemization](import-evidence-convergence.md#foreign-receipt-itemization-with-usd-accounting)).
The purchase date marks the timeline as order context, never delivery; confirmation supplies no
ledger date or ownership interval. Itemized acquiring Expenses stay authoritative. The unpurchased
quality check accepts confirmed live purchase links or real acquiring Expenses, excluding plans.

Mutable sources also name a typed item schema, adapter and transport exposure. The compiler rejects
duplicate relation/source keys, unresolvable mutation sources, invalid inverses and stale generated
bindings. Read adapters may expose paged rich rows through `entity.relation` and the kernel's
`listRelation` action. Purchase/Product reads select and count distinct live pairs before enriching
the page, keep explicit-link detachability beside movement evidence, and order by date/name plus id
(undated last). Filtered target ids constrain both page and count; a client never fetches a whole
relation to decorate one page.

After inverse and section derivation, the presentation compiler resolves each relation section's
filter binding, subtree scope, create seed and intent roster, sort, grouping and page size into one
plan that web and Apple consume; neither guesses a reference from a filter suffix. The target's
default create intent wins when compatible; otherwise the compatible intent must be unique or named
by `prefill.intent`, and ambiguous fields require `prefill.field`. Both clients default relation pages
to 50 rows. Query relationships render in Connected records rather than another filtered table;
public local reference fields must have a connected target group, and physical FK coverage requires a
graph path or a justified internal classification.

Shared AI Jobs expose every requesting Run; their optional owning Run is separate. Job subjects
exclude non-entity origins. Image processing links use the exact execution key. Lease-device links
keep an expired holder until release or reclamation. Photo membership and library sightings never
imply inventory ownership. Reviewed Email financial evidence keeps the account at review. Historical
leaves may name tombstones, labelled `(deleted)`; ordinary references require live targets.

### Deletion and merge

Lifecycle is separate from logical relationships. Physical edges carry stable domain meaning, and each
delete or merge operation declares its own disposition for every incoming edge. The integrity catalog
records whether the generic kernel or a specialized workflow owns execution. There is no logical
`deletionPolicy` and no inferred database cascade. Generic deletion blocks incoming references; domain
detach, cascade and merge policies stay explicit.

Deletion is one command. Soft versus hard deletion is a capability; the result names the deleted
public references and a non-null changed-row count for every affected-edge disposition. There is no
restore. Delete and merge confirmations show an advisory impact list (`entity.connections` with an
`operation`): each incoming edge group with its count and disposition. The mutation rechecks in its
own transaction and its structured refusal is authoritative. Domain command and identity reservations
that must precede the root row locks belong in the repository's `deleteHooks.beforeLock`;
`beforeDelete` runs after them and owns guards and effects before edge dispositions. Financial deletion
takes command keys and sorted occurrence locks in `beforeLock`; taking them in `beforeDelete` would
invert the financial writer lock order.

Merge is keeper-wins. Declared edges are repointed, only explicitly mergeable fields combine, and
uniqueness or workflow collisions reject the operation. Entity-specific merge code remains only for
irreducible transaction and collision rules. Accepted research proof follows its canonical Product or
Purchase subject independently of the source task; a merge folds only identical proof identities and
keeps independent evidence and support. Colliding Run targets fold only within the same Run, entity
kind and frozen work key, moving evidence and proof references before the absorbed task is removed.
Purchase and Run soft deletion keep proof against their tombstones. Product proof retains history and
blocks deletion; an Image hard deletion removes its proof before its worklist target and detaches
retained original evidence to the owning Run. These history references never claim ownership of an
Image.

## Connected records and graph

Web and the Apple apps render the graph, paths, inspector and connection review through one React
workspace; Swift owns its authenticated host and native record navigation, ranking and eligibility
stay server-owned, and CubbyKit keeps ordinary operation calls for native consumers. The wire example
`packages/schemas/fixtures/relationship-discovery.json` feeds both Zod and Swift mapping tests. Inline
previews and the Relationships section share one query result; the workspace's graph and list share
selection and loaded data, and graph state is local to the workspace.

`entity.explore` takes an entity reference and a depth of one to four and reads the manifest graph
breadth-first, returning nodes, directed edges, branches, explanatory paths and completion state. A
hop is a displayed relationship; a derived relationship keeps its provenance. Each branch contributes
its first 12 records and keeps `nextOffset` for paging through `entity.graph`, so deeper levels never
silently exhaust a large branch. Reads batch up to 25 roots under aggregate ceilings of 500 records,
1,000 edges, 32 reads and ten seconds. Completion distinguishes exhaustion from depth, pagination and
budget limits; returned paths explain explored records and never claim an unsearched branch has no
shorter connection. Distinct evidence edges keep distinct paths. Exploration keeps at most three
shortest paths per record; reaching that ceiling reports a budget limit while traversal continues
under its other budgets, and completed BFS layers still prove returned paths shortest. Connected
tables keep all distinct witnessed paths per paged target. Automatic summaries stay curated and never
expand through member, category or location hubs. `entity.graphPaths` is the destination-path search;
cycles are valid, and all traversal applies live-record filters, intermediate tables included. A zero
graph item budget returns exact branch counts with empty node, edge and item arrays, no labels,
previews or images, and no next offset.

The operation handlers hydrate each graph's optional `preview` from the selected-field list readers,
once per entity kind; those canonical reads own money, quantities and progress, and graph rendering
never computes a separate unit price or spend total. Detail-page connections use declared local
relationships and curated multi-step routes, never arbitrary reachability. Header context requests
the preview reader's `context` scope (curated route titles and witnessed paths); the default
`connections` scope groups all declared routes by target kind. Filter-derived relations keep their
filtered tables, including proposal states, and add query sources for accepted associations.
Proposals stay in Suggestion review; graph proximity never promotes them to facts and never enables a
write. External references have no local detail target.

`createConnectionCatalog` compiles each entity's directional relationships, grouped views, curated
context and named routes once. Only curated multi-step routes need entries (`curatedConnectionViews`
in `connected-view-definitions.ts`); new entities inherit direct and inverse coverage.
`relationship-paths.ts` supplies the directional relationships for table composition and graph
expansion. The preview reader composes the same paged query as a full connection table into one
statement for all requested groups, each keeping its count, limit and provenance. Table cells,
summaries and context disclosures reuse `connection-paths.tsx` for linked trails and batched cover
references. Distinct records with equal labels show their shortcodes; identity, never label
equality, controls deduplication. Named routes compose any number of logical steps; physical joins
stay in `compileTraversal`, which checks liveness on intermediate records. Graph roots follow their
manifest soft-delete capability (Emails and Runs have no deleted-at column). Graph edges and trails
carry the shared relationship witness (key, label, named source, physical provenance); Via labels
expand to the actual linked records. Retained tracking captures connect Shipments and Emails
independently of Email review or import status, without duplicate rows. Product purchase-project
context follows `expenses → project`, so a sibling product on the same order cannot lend its project;
multiple projects are reported together.

The only connection discovery is the Email purchase link; the
[entity connections guide](guide/entity-connections.md) owns its deterministic drain and acceptance.
Work queue reads count stored active pending connection state without rebuilding evidence; opening
evidence and applying a Suggestion keep their current-evidence checks, fenced in the domain
transaction, and no queue read starts discovery or model work.

FinancialTransaction Product connections follow confirmed purchase allocations through itemized
Expenses or explicit purchase–Product links, with inverse paths for Product navigation. A split
settlement includes products and vendors from every allocated Purchase, deduplicating targets while
keeping each witnessed path. Transaction context highlights purchase Vendors and Products; Product
and Vendor context exposes settlement Transactions. These are related purchase products, not a claim
that a partial settlement paid for a particular item or a new source of spend.

Statement labels identify Vendors from live, confirmed purchase allocations across all members.
Matching lowercases, trims and collapses whitespace; it never strips punctuation, store numbers or
suffixes. One distinct Vendor is a match even with one transaction; conflicting Vendors stay
ambiguous. The Vendors table's read-only **Statement labels** column derives all known labels from
the same history, including ambiguous labels on each supported Vendor. An explicit UI or MCP
allocation outside unattended Runs confirms merchant history by default; system and Run-scoped writes
keep existing confirmations but create none. Set `confirmsMerchant: false` when copying an inferred
Vendor; automatic retained settlement and automatic Email convergence always set it false, including
member-authenticated MCP convergence. Source amount corrections, amount-only edits and Purchase
merges preserve this provenance. Booking may identify an omitted Vendor from an unambiguous label, but
the resulting allocation is inferred and cannot teach the label again; label identification never
creates a confirmed Vendor or Product connection without an allocation. Specific order matching
still requires independent settlement evidence that does not contradict confirmed merchant history;
ambiguity blocks automatic settlement for every candidate until resolved.

### Product relationship route

Product connections follow evidence edge by edge. Stock, purchases, vendors, projects and tasks are
conditional branches from the Product, not a chain: a route continues through a branch only when the
record supplies evidence for every edge, so a Location never implies it caused a Purchase, nor a
Purchase that it belongs to a Project. Product's declared relations and its curated views in
`connected-view-definitions.ts` keep these distinctions:

| Connection             | Meaning and source                                           | Required distinction                                                                           |
| ---------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Stock                  | Product → InventoryEntry → holding Location                  | A holding Location is not an identity-only Location.                                           |
| Also a location        | Location whose identity is this Product                      | Keep separate from Stock.                                                                      |
| Expenses               | Acquisition or disposition lines keyed by `productId`        | Explain kit-owned expenses and explicit manual prices where applicable.                        |
| Purchases              | Explicit `purchaseProduct` links or itemized Expenses        | Label `Direct link`, `Via expense` or both; exit and future Expense rows are not acquisitions. |
| Vendors                | Attributed Product Expense → Purchase → Vendor spend         | An explicit `purchaseProduct` link alone is not vendor spend.                                  |
| Used on projects       | Explicit reusable-tool usage                                 | Keep separate from acquisition attribution.                                                    |
| Purchased for projects | Acquisition-spend project attribution                        | A Project may appear in both project branches.                                                 |
| Tasks                  | Nullable `Task.subjectProductId` links for non-food Products | Keep the task creation path and a truthful empty state.                                        |

Do not collapse paired meanings into a decorative graph. A recategorized Product keeps historical
project-use evidence visible and linkable while category-gated mutations stay read-only.
Soft-deleted intermediates and targets never appear in counts or previews; real unassigned project
attribution is shown. Every linked target opens its canonical `/<plural>/$shortcode` route.
`ProductPurchaseOut` carries `vendorName`, not `vendorId`: Purchase rows open Purchases, and the
Vendor branch owns Vendor links from its own evidence. Specialized Product sections keep their
mutation behavior. The [local journey coverage map](agents/core-journey-e2e.md) tracks the
relationship browser check.

## Identity, attachments, and the physical graph

Every shortcode entity has one durable `Entity` row (ADR 0006); payloads bind to it with a composite
`(id, shortcode)` FK. Shared transactional writers create identity before payload insertion and keep
tombstones on soft and hard deletes. `finalizeMerge` records one-hop, path-compressed `mergedIntoId`
links. Reads and writes through a merged-away code refuse with the survivor's code
([ADR 0024](adr/0024-repository-read-declaration.md)); a deleted code refuses with the deletion date.
Codes are never reused, even a hard-deleted payload's.

Direct files are `EntityAttachment` rows: gallery photos and purchase documents (`attachment`), a
Cookbook `cover`, a Vendor `logo`. `purpose` is Product-only and `documentKind` Purchase-only; Product
gallery writes store `item`, other galleries leave purpose null, and readers treat a null document
kind as `other`. Detach soft-deletes; a removed subject's attachments are detached and reaped; an
upload's idempotency key belongs to the attachment, not the file.

The shared image API (`image.attach_file`, `image.attach_existing`, staged `image.create_file_upload`)
accepts every declared direct-image target. Galleries use `role: "attachment"` by default; Cookbook
covers require `role: "cover"` and Vendor logos `role: "logo"`. Singular attachments replace the live
slot only after image validation succeeds; PDFs cannot fill them. The subject lock serializes
replacement, count preconditions and idempotency keys; a retry reuses only the still-active
attachment. Replacement locks incoming and outgoing images in id order, and reaping checks ownership
after taking the image lock, so a stale reference check cannot delete a concurrent attachment.
Replaced images are reaped only when no live record references them.

Attachment inputs labeled `application/octet-stream` are unknown formats: the shared attachment
service inspects their bytes with the same image/PDF signature checks (and image dimensions) as typed
inputs, then stores the resolved MIME type and matching extension. Base64, URL and staged-upload
inputs share this validation; unknown bytes and unreadable images fail before storage. A filename
never establishes the format, and a specific MIME label must agree with the bytes.

Vendor list row menus, details, inspectors and Problems offer explicit logo fetching from the
recorded website (Fetch logo when missing, Refresh logo otherwise), with shared per-record pending
state. Missing websites keep the action disabled with an explanation and the route to Edit; fetch
failures keep the existing image and expose raw diagnostics for retry. Native uses one Fetch or
refresh logo action with the same prerequisite.

Before linking or importing an Email, the `mail-attachment-purpose` Decision classifies each retained
file from the Email context and attachment metadata. Only a high-confidence `purchase_document`
result attaches automatically; `shipping_label`, `uncertain`, low confidence or evidence exceeding the
Decision context bound leaves the file with the original Email. Filenames and subjects are hints, not
rules. The body can still establish a shipping charge, and originals stay retained and readable.
Inference runs before the linking transaction; publication rechecks the Email checksum and attachment
metadata/checksums. Model failures propagate without a heuristic fallback. Explicit attachment stays
available.

The physical graph is composed at read time from `ENTITY_EDGES` and `ENTITY_EDGE_OWNERS`
(`generic/entity-links/repo/entity-edge-source.ts`): `(edgeKey, sourceKind, sourceId, targetKind,
targetId)` with both ends live. It backs the Relations tab's Connections, the impact preview, the
graph explorer's physical edges, the Problems orphan finder and MCP `entity_graph_read.connections`.
Writes never go through it. Agents read declared relations, including multi-hop paths with no
physical edge, through `entity_graph_read.graph`; declaring a relation is enough for web, native and
MCP. The orphan finder restricts graph arms to edges touching its checked kinds before reading rows;
polymorphic source arms stay eligible; both endpoints must be live; same-kind parent edges connect only
their target, so an empty child location stays a cleanup candidate.

Two generic tables carry pure pairings and identifiers (ADR 0007):

- `EntityLink(kind, fromEntityId/fromKind, toEntityId/toKind, quantity)` holds every pure pairing of
  two entities: `purchaseProduct`, `projectTool`, `gardenEntryPlanting`, `productComponent`,
  `taskDependency`, `projectDependency`. Link kinds are declared in
  `packages/schemas/src/entity-links.ts` (endpoint kinds, quantity, self-link and cycle rules,
  per-end role, label, liveness, merge collision rule); the table's CHECKs and edge-source branches
  derive from that declaration, and write helpers live in `generic/entity-links/repo/entity-links.ts`.
  Every query names its `kind` and filters `deletedAt`. Dependency reads and writes resolve the kind
  from the entity's `blocked-by` relationship path.
- `EntityExternalId(entityId/entityKind, source, kind, externalId, url, isPrimary)` holds every
  identifier an outside system gave an entity; `ExternalSource` registers source slugs. Kinds and
  their entity kinds are declared in `EXTERNAL_ID_KINDS` (`packages/schemas/src/external-id.ts`), such
  as product identifiers (`asin`, `retailer_sku`, `gtin_14`, …), `settlement_ref` on financial
  transactions and `folder` (Drive) on projects. A live `(source, kind, externalId)` names one entity;
  rows soft-delete with their entity. A Vendor may own several sources, but exactly one carries
  `issuer`: Product identifier resolution, exact lookup and import fences read only that source.
  Ownership comes from explicit registration or a member action; `ensureExternalSources` registers
  slugs unowned, since a slug's spelling never names a Vendor. Merging two Vendors that each have an
  issuer is refused until one is reconciled, and Problems lists Product identifiers held under a
  Vendor's non-issuer source.

Research belongs in ordinary editable `notes`: preserve links or shortcodes, relevant excerpts,
field/variant context and observation dates as prose. Notes have no field-support or current/stale
contract and do not verify identity; inherited values resolve through field declarations
independently of research. Merge preserves both records' notes, keeping original whitespace and
avoiding exact whole-note duplicates; Purchase folds lock both records before reading notes so
concurrent research appends survive. Evidence-marked connected views (purchase documents,
accepted/reviewed Emails) stay live relationships in Connected records and never certify a researched
field.

### Collection changes

A field declared with `collection: { key }` accepts patch items on `entity.update` as well as a full
replacement: `{op: "add" | "replace" | "remove", key, value?, expect?}`. All preconditions are
checked before any change. Text arrays (Product `aliases`, `tags`) patch in the kernel; Product
`externalIds` patches through the Product repository, which keeps primary and secondary slots, GTIN
normalization and global identifier ownership. Add preserves every identifier and the current
primary; an empty slot selects its first value. Explicit `isPrimary: true` demotes the previous
primary without removing it. Make primary replaces the targeted row's primary attribute; replacing an
identity value is a targeted remove plus add in one atomic patch, with the old identity in the remove
key. A full array stays a full replacement for explicit API callers. Record collections declare
`primary: { key: "isPrimary", scope: ["source", "kind"] }` when role controls apply. Attribute
replacements carry the stored URL and primary role as expectations. Baseline identity keys preserve
literal non-barcode bytes; only declared barcode kinds use Rust identity normalization, and source
follows its slug policy.

Ordinary web and native update editors submit keyed patches. Their single local collection draft
keeps an immutable saved baseline and explicit Add, Replace, Remove and Make primary intent;
normalization removes that wrapper before validation. Mounted optional web controls may register
undefined leaves; the local parser omits unset leaves while keeping the strict baseline. Register and
write the row-intent array as one form field, so a background refresh preserves the whole dirty
collection (including null removal intent) rather than merging saved identities. Untouched
collections are omitted. An invalid dirty native draft keeps Save reachable so the error handler shows
its diagnostic above preserved input; a valid empty patch stays unsavable. Create materializes the
initial full collection.

Canonical GTIN digits do not establish the observed UPC/EAN encoding: barcode displays use GTIN and
keep canonical digits unless encoding evidence exists; validated book identities may display
ISBN-13. Primary and secondary barcode displays share kind/source/role metadata across web and
native; stored URLs stay links. Committed identifier audit effects keep every changed value and
primary role without truncation, and audit timeline details render as wrapped literal text (only
explicit event links navigate). Historical read effects compare URL storage policy directly without
input normalization or repair; missing committed sides produce diagnostics, not an invented baseline.
Provider lookup links belong to the lookup workflow.

Product create/update accepts one write-only `barcode` shortcut for barcode or ISBN input;
`primaryGtin` stays a derived read of `externalIds`. Omission leaves identity alone; null retires only
the current primary barcode and promotes the oldest remaining one; setting it selects the primary
without removing others. The shortcut builds a collection add/promotion or targeted remove and shares
the writer's collision checks and primary repair. Find-or-create recovers database and domain identity
conflicts by rereading the exact requested GTIN after rollback; explicit create/update still refuses
collisions. Provider lookups compact Unicode whitespace and hyphens like the writer while keeping the
supplied barcode width, and translate validated book identity to ISBN-13. The native barcode control
keeps ordinary text entry. Books inference comes from validated ISBN identity, with Food evidence
taking precedence. Create exposes the barcode shortcut in every category; ordinary update exposes the
identifier collection without a second barcode draft.

## Classification field policies

A classification decides, per field of the record it classifies, whether a value is expected and
whether it is allowed, in one vocabulary (`fieldPolicyValues`: `required` gaps a missing value,
`not_expected` and `unknown` raise no gap, `not_allowed` also refuses a value). A fixed classification
declares it under `capabilities.classificationPolicies`: the classifier enum, optionally the
classified entity and its reference field (omit `target` when the classifier is on the governed
record), and per target field a `byValue` map plus an `otherwise` policy. Same-record `not_allowed` and enforced `required` policies declare an actionable refusal. The generator checks every
name and value, requires a field refused by default to have exactly one admitting value, and emits
`classification-field-policies.gen.ts`. A household-editable classification keeps its policy per row
(SpendingCategory `productExpectation`), and `@cubby/schemas/classification-field-policy` registers
both shapes behind one evaluator (`isFieldAllowed`, `classificationValuesWhere`,
`impliedClassification`). The SQL evaluator compiles column policies against their declared owner
table, so inherited Expense category resolution and policy evaluation share one path.

ProductCategory `feature` is resolved through the Product's category and its nearest bound ancestor.
An ingredient or USDA link is allowed only under Food and an ISBN only under Books; a write carrying
one files the Product under the admitting feature (`impliedProductFeature`), and field order is
precedence, so food evidence outranks an ISBN. A model is optional across categories; identifier
sufficiency is the shared quality rule. Consumers read the evaluator, never a feature literal:
category admission on create, update, merge and reviewed reassignment, and decision-model targets
(`suggestFields` skips a field the recorded classification refuses via `classificationRefusesField`;
an unclassified record is not refused, since the write classifies it; post-import auto-fill rechecks
under its row lock). Each declared classification supplies its effective-value resolver in the
server module's typed `classificationSources` map.

A same-record policy reads the classifier from the governed row. Expense `lineKind` refuses a product,
a stored spending category and a stored project on every line except `principal` (a tax, shipping,
fee, tip or discount line follows the split of the Purchase's item lines, shown as "Follows items"),
and `lineBasis: allocation` refuses a product; Location `furniture` requires its Product; GardenEntry
`kind` expects notes on a note and an amount on a harvest. `enforced: true` (same-record only) emits
one CHECK per field into the derived DDL, so the database refuses every write path as well as
`assertClassificationPolicies`, which every write calls first; a field's `refusal` is the actionable
message and its `gap` names the public check reporting a missing `required` or present `not_allowed`
value. Reclassifying a row clears a stored field the new value refuses unless the same write sets it,
then validates once. Split parts and receipt replacement lines inherit a stored spending category only
when their final line kind allows it. The editor hides refused fields, and a Suggestion request drops
refused targets, refusing only when none remain.

A `relation: true` entry governs a relation the classified record takes part in: ProductCategory
`feature` admits a Product as a project tool only under Tools, Tool accessories and Software, and
refuses a Food Product as a Planting source. Relation entries never imply a classification. Category
change, Planting writes, project-tool attach and Product merge read them through
`@cubby/schemas/product-category-relations`, which entity declarations must not import.

## Product Brand and Purchase Seller

`Vendor` is the canonical identity for both roles. A Product's optional `brandId` names its marketed
**Brand**; a Purchase's required `vendorId` names its **Seller**. Product inputs accept the Vendor
reference, and reads expose the nullable `brandName` through the reference's label path. A physical
factory or descriptive manufacturer claim is source evidence, not a second identity field. Live
Vendor names are unique ignoring case and surrounding spaces (deleted names can be reused); automatic
name creation uses the same constraint to resolve races. Strong same-Brand comparisons use the
reference; name and alias text can retrieve candidates but never prove identity. Duplicate identity
review belongs to the shared Vendor roster.

Null Brand means unknown. The system-designated **Generic / Unbranded** Vendor is an explicit Brand
and satisfies Brand presence; neither null nor Generic sets `Product.commodity`. Generic can only be
a Product Brand (including a pending photo proposal); it cannot be a Purchase Seller, VendorAccount
target or identifier issuer, and its identity cannot be deleted, merged or converted. It has no
fabricated website or logo and is excluded from Vendor website/logo quality, the Vendor Research
queue and Gmail order discovery. Ordinary Vendors stay eligible for scheduled Gmail discovery even
when created only as Brands; the next pass recomputes targets from verified receipt senders and
website hints, and the immediate mail-search action stays available. A shared website is a discovery
hint and never confers identifier namespace ownership across Brands. Registered issuer sources and
every `(source, kind, externalId)` tuple, including `manufacturer_part`, keep their identity when a
Vendor is renamed. New explicit Vendor claims use its registered issuer; URL-only claims need a
registered host source.

The Product's `brand` relation and the Vendor's `branded-products` relation are separate from the
Product's purchased-from `vendors` relation and the Vendor's `products` purchase evidence. Vendor
merge repoints Product Brand references and pending photo Brand references; deleting an in-use Brand
blocks until they are reassigned. Pending photo create drafts and existing-Product Brand edits store
their selection in the proposal's Brand FK, following Vendor merge and delete policy; a null edit
placeholder preserves an explicit clear and an omitted Brand edit is no change. Original manufacturer
evidence stays in the proposal's read-only `sourceManufacturer` column. Proposal persistence locks
selected live Brands against concurrent merge/delete; unresolved non-null references fail.

The Vendor list shows a derived Role: Seller for a live Purchase reference, Brand for a live Product
brand reference, Both, or Unused; deleted records, VendorAccounts and pending proposals assign no
role. Each role has a labelled, colored icon pill; Role filtering selects exact categories with any-of
semantics (Seller + Both finds all sellers), and grouping uses the same four. The default list is
ungrouped, sorted by descending seller spend. The Vendor table separates Purchasing fields from Brand /
catalog with declared column groups. Brand / catalog counts live Products whose `brandId` is this
Vendor, distinct live categories and distinct products with purchase-linked expense history; its
default branded-products preview uses the direct Brand relation with the `brandedProduct` filter
prefix, while Purchasing's optional products preview uses purchase evidence. Brand spend sums signed
live `Expense.cost` through live Products of this brand and live Purchases across all sellers;
unlinked lines cannot be attributed to a brand. Seller spend includes all live lines through the
seller's live purchases. The two spend columns overlap and must not be added. Counts and spend exclude
deleted Products, Purchases and Expenses; refunds stay. Seller history adds live line count and first
purchase date. Documented purchase count uses the primary receipt/invoice predicate (absence is not a
gap); missing-itemization count uses the required-itemization policy, excluding unclassified and
not-expected purchases, and zero does not imply full assessment. Recent expenses belongs to
Purchasing. These are read-time aggregates.

## Product classification and photos

`ProductCategory` is an editable tree of at most three levels. `Product.categoryId` references the
most specific known node; its read-only `category` projection holds the root-first path and inherited
behavior binding. Products can stop at any depth or stay unclassified; filters include descendants.
Names, aliases, descriptions and display order are editable. Each feature (Food, Books, Music, Tools,
Software, …) is bound to exactly one category, usually a root; a nested node's own binding overrides
its ancestors' (Tools › Tool consumables). A binding is permanent: it survives renames and moves and
cannot be cleared, replaced or deleted. Moving a subtree validates all affected Products against the
same identity and dependency constraints as a direct change.

The inherited `feature` also marks service accounting: `services` and `software` Products represent
ongoing access, usage or obligations. Bind Services on an ancestor to cover utilities, insurance and
similar categories; there is no per-Product switch and names do not control behavior. Pricing,
quantity and ownership SQL share `serviceCategorySql`, which delegates to the canonical
`categoryFeatureInSql` predicate (declaration-owned ancestors, depth and cycle guards); price scalars
holding a Product row classify its category directly. No service membership catalog is stored.
Actual Expenses keep their amounts and quantities, but service quantities never accumulate stock,
establish ownership or derive a valuation or unit price; a stored service price stays assignment
intent with no effective valuation. Physical untracked Products keep their rules.

The shared Product charge report shows positive actual Expense-line counts, credits,
refund-inclusive spending, the latest dated positive charge and a bounded history linked to the
Expense list; unknown amounts and dates stay explicit and planned and deleted Expenses are excluded.
It never turns a bill average into a fixed price or infers a subscription, coverage window or
renewal. Web and native omit ownership/inventory guidance for services. Service identity requires no
model or external identifier. The Product list Price column is labelled Cost: physical Products show
their effective item price; services show the mean of positive actual charges (credits, zeros and
unknown amounts excluded), labelled per charge, with count and latest charge in the explanation.
Sorting uses the displayed amount; the Item prices footer and inventory valuation exclude service
averages. Detail shows Average charge and explains why it is not a monthly rate; service Unit price
and valuation fields stay visible with an applicability explanation.

Full detail pages and inspectors keep all declared user-facing field sections, including empty ones.
Missing values read Not recorded, with Add when editable; inapplicable values explain why. Allocated
references stay content even when their scalar resolution is null. Internal fields stay under
Technical details. Lists keep compact absence markers.

An Image has provenance (`own`, `catalog`, `unknown` or `screenshot`, plus optional source name, page
and asset URLs). Its Product attachment has nullable purpose (`item` or `label`); unset purposes keep
gallery behavior, and labels are supporting evidence that never supply direct or borrowed covers.
Product reads keep separate item and label arrays with purposes. MCP detail exposes all attachments;
`imageCount` counts every attachment for upload preconditions, while item/label counts count
displayable images. A cutout is a rendition of one Image: original bytes stay the analysis source and
fallback, and the original can be selected explicitly. Confirmed image descriptions stay
authoritative in display, classification and search even without generated analysis; see
[Suggestions](#shared-proposal-queue-and-automatic-decisions) for confirmation.

An Image's _who took this and when_ is derived, never entered directly. `ImageSighting`, a non-entity
child table of Image, records each report that a stored Image appears in one Ledger Party member's
photo library or cloud asset store, from one reporting `Device`; it is unique per `(imageId,
ledgerPartyId, assetKey)`, so a second device reporting the same synced asset updates the sighting.
Sightings are written only through `image.recordSightings` (and a photo-import commit's `library`
block), read on Image detail as `sightings`, with audit history on the parent Image.
`deriveImageCapture` reduces live sightings, else embedded EXIF, to the Image's `capturedAt`,
`captureLocation`, `capturePlaceName`, `captureDeviceLabel` and `capturedByPartyId`, recording
`captureAttribution` (`none`, `derived`, `ambiguous` when members' evidence ties, or `confirmed` once a
member sets it, never recomputed). Every sighting write or reporting-device delete reruns this in the
same transaction (ADR 0005 owns precedence).

## Suggestions

Suggestion families are `field`, `recommendation`, `statement_transaction`, `transfer_pair` and
`product_pair` (`server/generic/suggestions/repo/suggestion-family-declarations.ts`). The generic
owner is `generic/suggestions`; field-resolution evidence belongs to `generic/field-explanation`.
Product-match review commands belong to the `productMatch` contract.

### Field suggestions

`control.suggest: { basis, mode }` marks a field whose value the decision tier (Jev/Clef) infers from
named sibling fields, so the browser editor can auto-fill it while untouched and offer a one-tap apply
once a value exists. `basis` names model field keys on the same entity only, never an
`intents.editorFields` pseudo field (detail, table and bulk surfaces have no editor-field data).
`mode: "fill"` (the default) targets a select-controlled enum, a singular reference or a nullable text
field (a roster-backed name such as `expense.vendor`); the compiler rejects anything else, a basis key
that is not a model field, a basis naming the field itself, and any cycle in basis → target edges, so
one request resolves every target in dependency order. Enum targets may declare `allowNone: true` to
offer an evaluated decline that proposes no replacement or clearing; exhaustive enums keep it false.
A target with no physical column declares `backedBy`: same-record columns `{ column }` or referenced
columns `{ entity, column, via }`; the generator validates them and rejects a derived target without
backing, and derived DDL supersedes pending suggestions when a backing column changes (referenced
backing watches every target row linked through `via`).

`mode: "prune"` targets a `text-array` field and proposes removals: entries restating a `basis` field
(a Brand name, a classification path segment) are candidates to drop, never to add. A prune target
judges its own entries, so it is an implicit self-basis: naming it in `basis` is an error, and client
and server fold its current value (JSON-encoded) into the basis. The `FieldSuggestion` carries
`operation: "remove"` and `removals[]`; review surfaces render a removal proposal, never an auto-apply;
a form-mode `FieldSuggestionProvider` skips prune targets by default (list and detail request them).
Prune acceptance verifies the saved remaining array and records the same saved-field receipt as a set
proposal.

Suggestion inference selects only the union of its declared basis and target read paths through the
canonical detail reader, keeping envelopes and reading effective values through those paths
(including nested reference identities); a governed value is never recovered from an absent top-level
key. Hidden editable references declare their public `display.readPath` when the identity is nested;
a declared suggestion consumer permits that path without a visible surface. Unavailable governed
inputs fail preparation instead of becoming empty additions. Suggestion readers honor `readKey:
null`: an intent-only reference reads its declared projected relation, keeping an absent deferred
projection distinct from a loaded empty relation. The kernel-owned `readSelectedEntityRecords`
assembles canonical selected detail rows for preparation, field refresh, queued checks and
publication validation; selections with governed root fields keep `fieldResolutions`, and these
partial rows never authorize a write or replace live publication fences.

Shared AI selection sends the entire shown roster to the decision model only when it fits both the
254-choice limit and the 32,000-byte serialized UTF-8 envelope (subject, rules, labels and the none
option included); otherwise the fast chat tier selects from the same roster with explicit candidate
ids, and an unshown id resolves to null.

A field's `suggest.apply` says who decides a confident answer. `review` is limited to concrete
consequential exceptions: FinancialAccount provider/network and sole purchaser (financial identity and
attribution), Expense line kind (accounting role), Cookbook and Device Product links (specific owned
objects), Inventory location (a placement move), ProductCategory feature (it decides which fields a
subtree carries) and SpendingCategory itemization and Product expectations. `offer` keeps an answer
as the picker guess and never writes it: Expense project and Product, which move spend or cost basis.
`fillOnly` fields (Vendor and Purchase defaults, Project trade) are filled when empty but never
revised, because other records inherit them. Ordinary descriptive fields, including record emoji,
use the common policy; effective derived itemization values are
populated and protected. A field's `suggest.undecided` names a stored placeholder that records no
decision: every open-field check treats it as empty. Vendor spending profiles
default to `unspecified`, their undecided value, so Cubby fills a confident
profile once (`fillOnly`) and never replaces a person's choice.

Saved-record spending review is declared per field as `control.suggest.financeReview.context`:
`finance` for the Purchase fallback and Expense category, `vendor` for the Vendor default category and
spending profile. The context selects the saved evidence the server reads, the fingerprint-fenced
writer (`finance` books `spendingCategoryId`; `vendor` patches the declared create-only Vendor fields) and the
saved-record gating web and native read from the manifest. FinancialTransaction's read-only
`spendingCategoryId` declares no review. The `financeCategoryReview` wire enums keep their literal
order; a type check requires them to list every declared entity and field.

### Suggestion storage and review

A Suggestion stores immutable typed subjects, judgments, evidence and nullable original producer
metadata. Suggestion and decision child handles accept the full PostgreSQL GUID shape, including
hash-derived identifiers with arbitrary version/variant bits, preserved exactly by readers, review
commands and receipts. The row's mutable columns hold current targets, field supersession and exactly
scoped suppression; merges and deletes change those columns, never subjects. Runs are nullable
provenance references, not history owners. The family registry validates current targets. Mail
decisions and findings live with their
[domain owners](adr/0011-email-as-a-first-class-entity.md#decisions-and-reviews-have-email-owners),
never on a Suggestion. Review families using this storage are fields, Product pairs, statement and
transfer pairs, and generic recommendations; statement and transfer-pair Suggestions share the
canonical charge preview mapping and charge identity parsing. Non-actionable Product pairs stay
ordinary history.

Live field inference shares one immutable publication per subject, full evidence, exact proposal and
served model/prompt policy, keeping the first actual producer and proposal across requesting Runs;
publication identity excludes requesting Run and execution ids. Live and stored inference share an
internal review identity over the captured feature, prompt, model, policy dependencies, field subject,
exact proposed value and operation kind; an exact wrong review stays resolved across either entry
point until evidence, policy or candidate changes, and unknown evidence receives no invented identity.
Live inference stays inactive; only stored sweep advice enters the queue. A pending field Suggestion stores the snapshot of its target, declared basis, direct
reference rows and latest audited write of that field; reads hide it and apply refuses it once the
snapshot differs (a no-change save keeps it pending; a restore after an intermediate write does not).
Pending Product pairs are hidden the same way once either Product's identity snapshot changes, while
their history remains. Suggestion context fingerprints keep assignment, outcome and provenance kind,
excluding refresh timing and presentation controls. A changed target, basis or backing field makes
older pending Suggestions ineligible on reads; a later sweep supersedes prior pending rows for the
same record and field. Historical hashes, model versions, provenance and actor intent are never
reconstructed.

`suggestion.review` and `suggestion.reviewBatch` (MCP `suggestions.review` with `items`) record
immutable review; each batch item has its own outcome. Draft and
history verdicts settle on their own; an applying review commits with its application, so a stale
or refused application records nothing and the same operation id may retry with a corrected review.
Every applying review sends `expectedFingerprint`, the listed row's `fingerprint`, naming the
version it reviewed; a family whose list computes that fingerprint live declares `applicationKey`.
A mismatch refuses, naming each part of the family's `applicationTerms` (what its apply writes) that
moved. Statement applications compare only the chosen action's terms inside their apply, so drift in
evidence the application does not write never blocks.
A decision records correct, wrong, uncertain and presentation-only dismissal
separately, with an explicit correction-presence discriminator so a corrected JSON null survives.
Draft acceptance records history; saved application commits a separate immutable command-bound
receipt in `decisions` with the domain write. Explicit single and batch finance Apply acknowledge each
Suggestion only after the finance writer saves; recording the saved default preserves a newer draft.
An identical command replays its receipt before current status checks; conflicting operation-id reuse
is refused and another command cannot inherit a resolved application. Public operation ids reserve
internal receipt namespaces; replay validates the receipt kind, command decision binding and recorded
outcome. Current-evidence and domain-authority checks fence field writes, Email corrections and pair
merges. Email link application revalidates its expected active Suggestion and current target after
Purchase, Original and Email locks, so a waiting review cannot replace newer authority. Relevance
application requires an explicit related or uncertain correction before recording feedback;
unrelated grading stays history-only. Unserved model trials stay outside member review.

A bare wrong verdict is a Miss without suppressing future evidence: it resolves the current Problem,
and canonical publication of the same evidence and policy keeps that review, while relevant evidence
or policy revisions may publish a fresh Suggestion. Older ambiguous reject/dismiss outcomes stay
ungraded with their original field-value, pair, recommendation-group, relatedness or tag-preference
suppression; existing corrected values and explicit labels keep their semantics. Field applications
keep AuditLog receipts and distinguish automatic from explicit member acceptance. Evaluation-only
Email grades never change routing; frozen sample rosters keep original predictions, strata and
inclusion probabilities.

Suggestion review identity and admission reads select only their identity or served-status fields;
immutable evidence loads only in the family action that consumes it, so generic history and review
plumbing never transfer large snapshots. Canonical fingerprint serialization traverses validated JSON
directly, sorting object keys and keeping array order and scalar encoding, without revalidating
subtrees; normalize dates and optional values at the input boundary. Stored-family outcome counts use
one status query scoped by family and optional Run. Suggestion lists resolve record scope once through family discovery and pass matched ids to family readers. Families declare primary records and subject JSON reference paths, with guards for the stored field or scope; recordIds matches subjects, while account and vendor filters select related statement suggestions. The touching reader binds requested records and owns reverse discovery. Paths that store shortcodes can declare live-record resolution before matching. Statement settlement graph discovery is the only graph exception. Review uses family subject and projection
schemas, the common verdict set and transaction-bound application by default; families keep explicit
exceptions.

Correction serialization uses the affected domain rows: Suggestion review locks its Suggestion row;
Image review locks its Image first. Email evidence writers keep serializable retries and their Email,
Original and Purchase locks, with no household-wide lock key; sender address reservation protects a
new address with no owning Vendor yet. New decisions use member, automatic or system authority;
retained historical decisions keep their recorded authority. The uncertain member verdict is written
by Apple connection review; ungraded is an internal receipt. Draft intent is supported. The native
editor shares `ai.suggestFields` with web. Email review keeps its transaction and intent checks
without a frontier receipt. Transfer movement labels run only when weak movement is the sole blocker;
structural conflicts stay for review without a model call.

Product pairs come from deterministic import-time matching and the `product_enrichment` propose
action. Exact identifier retrieval is independent of name/model gates; semantic similarity is
candidate evidence. Reads use stored pair Suggestions. Current nonnull model disagreements and
retained historical identity conflicts block pair application, including weak recommendations; equal
current model strings or research notes neither verify identity nor clear conflicts; uncertain
variant matches stay pending. An explicit merge can supersede historical advice only after identity
inputs differ from every retained conflicting comparison, with current conflicts rechecked
transactionally; automatic matching stays blocked and notes never unlock it. With exact identifier
admission they become identity-conflict Problems. Raw receipt SKUs keep unknown variant granularity
and stay ranking evidence even with matching size, color and pack; explicit ASINs can establish exact
identity; uncorroborated title text and partial variants stay ranking evidence. Connected pairs may
share one Problem presentation, but each merge names one independently assessed pair and rechecks its
evidence. Merging and survivor image ordering commit together; stock combines, and duplicate
receiving is a separate reviewed inventory correction. A merge requires explicit survivor and impact
confirmation, and identity conflicts cannot merge.

### Shared proposal queue and automatic decisions

Automatic application policy is fixed code ([ADR 0028](adr/0028-cubby-acts-first.md)): confident
answers for open or Cubby-held `apply: "auto"` fields and clean supported import spending always apply
through their domain validation; attaching an existing transaction requires review. There are no
member switches or Rules tab. A Wrong decision prevents unchanged work from applying again. A member
correction of a Cubby-set value rechecks up to 25 similar Cubby-held values through the decision
model; nothing is copied. Corrected null stays distinct from no correction, and an apply intent
alone, a draft or a history-only grade changes nothing.

The review implementation and wire use Suggestion names (`suggestionId`, `suggestionIds`,
`targetSuggestionId`). Immutable publication keys and receipt kinds keep their original spelling so
retries and existing decisions keep their identity.

The `/suggestions` page lists what needs a member from fields (Disagreements and `apply: "review"`
fields, through the field family's `disposition` column; guesses are listed only when asked for with
`disposition: ["guess"]`), statement transactions, connections
and recommendations, Product pairs and transfer pairs on one server-filtered table (`suggestions.list`
over the family registry): family chips with counts, each family's columns, inline evidence, keyboard
review (↑/↓, →, A, D), a confirmed "Accept N clean" that re-lists before each chunk, bulk Dismiss and
Never suggest (no bulk Wrong), and Find suggestions, which estimates and starts a Sweep. Each family
owns presentation, affected-record discovery and review commands in one typed declaration; generic
readers compose the same static declarations. The registry exposes live accessors because family
implementations depend on generic review, and eager values could capture an unfinished circular
import. Reference resolution, touching-record queries and Work tokens have separate runtimes.

Every Suggestion is published through one module, `suggestion-publication.ts`; its immutable insert
and pruning have no other caller. Statement transactions, transfer pairs, connections,
recommendations, Product pairs and field sweeps each declare a `SuggestionFamily` slot and its
suppression, unchanged and replacement policy. A candidate its family declares `unapplicable` (a
transfer pair that cannot apply, a connection relation without an apply path) retires the slot's
pending rows instead of publishing, so no pending row exists without an apply path. Run-scoped photo
drafts and live field answers publish as exact immutable evidence keyed by publication, which never
suppresses, matches or settles a queue row.

The page's `family`, `record` (`<kind>:<CODE>`) and `runId` params scope the queue. Every
multiselect, including Clean, offers **is / is not** through the shared filter editor with `__not__:`
state and `<column>Exclude` URL parameters; quick pickers edit included values while keeping
exclusions. Each family declares filters, sorts and account × month grouping with
`defineRelationList` in `packages/schemas/src/suggestion-list-declarations.ts`; the web codec, route
keys and operation input derive from them, and SQL uses `compileDeclaredFilters`. The single agent
queue read is `suggestions_read.list`: filters use column names, `<column>Exclude`,
`<column>Presence` and numeric/date `<column>From`/`<column>To` bounds; confidence bounds are
fractions from 0 to 1, the unit rows carry; `recordEntity` scopes record kinds independently of the field family's `entity` filter.
Exclusions keep rows with no matching value. Only `meta.cleanCount` remains, because it controls bulk
acceptance. Current family facts are checked before filtering and pagination so stale evidence never
inflates totals; family freshness and derived facts run through their eligibility reads.

Every entity list batches the queue's pending counts and opens its inline review; detail pages show a
scoped Suggestions section. Family declarations expand every affected record: both endpoints of
connections and pairs, reference values of fields, and a statement row's account and candidate
Transactions. Scoped reads resolve the record scope before joining immutable evidence, so unrelated
pending families never enter the evidence join and overlapping branches count each Suggestion once;
Suggestions and Automatic decisions share the statement settlement predicate and its deletion rules.
These are live canonical reads; any future stored projection must keep dynamic memberships and
complete invalidation. Passive record reads never discover or publish advice. Similar-Product
browsing stays informational; photo-import choices stay in their Run.

The **Changes by Cubby** tab is the generic audit of automatic decisions, newest first, with family and
review-status filters; `/automatic-decisions` and the older automatic-application URL redirect there,
preserving record and audit-family scope, and Workbench bookmarks redirect to the queue or the Product
detail. Field rows offer Keep and "Wrong, clear it" (`suggestion.fieldAuthority`), and editing a
value there is the correction. Email relevance, automatic Email links,
mail-import outcomes and automatic-rule receipts enter through declarations; member-made Email link
decisions stay ordinary history. Mail decisions read from `EmailClassificationObservation`,
`EmailPurchaseDecision` and the `target_outcome` RunOperation. Report incorrect records Wrong feedback
through the family path (an `EmailReview` for mail) without applying a correction or pausing
automation; applied effects remain, and affected records link to their domain actions. Wrong and
corrected decisions stay in the audit. Email predictions with `application` `unverified` appear as
**Unverified application** even when they disagree with current relevance; ingestion sets
`application` atomically with routing, and known unapplied predictions stay ordinary history. The
`/ai` page's Decisions tab catalogs every decision's basis, options, rules and rendered request
(`ai.decisionCatalog`) with a Jev/Clef Try panel. Work has one row per Suggestion family linking into
the page, and a Sweep Run's detail links to its own.

Run **Results** separates direct record changes, published Suggestions and processed inputs. Direct
changes come only from `AuditLog.runId`, counted as distinct records per action with a bounded linked
list (repeated edits count once; a record created and edited appears in both counts); Changes keeps
the full paged field history. Publication totals come from `Suggestion.producer.runId` with current
statuses from the same row; a replaced undecided row is deleted and leaves the total, except in the
field family. Later manual or automatic applications become Run-owned only when their writes carried
that Run; attribution is never reconstructed from review status. Processed RunStep counts are work
units, not distinct entities. Order counts and target review stay in the import journeys; photo
review stays in its own section.

Automatic field writes use the high-confidence boundary shown to members (85% or above) with
current-evidence checks, and follow [field authority](#field-authority-and-automatic-writes). Only
declared `mode: "fill"` fields with `apply: "auto"` qualify. Preview and persisted application share
the threshold, which does not change financial acceptance rules. Eligibility reads only the target and
its declared policy basis with their assignment and result envelopes, and acceptance repeats the
checks under its write fence. Reads carry `ownership: { kind: "record" }` for every own value; who set
it is answered by `fieldExplanation.origin`.

Confirmed image description text, content hash, confirmation time and owner provenance live on the
Image row. A member correction confirms one Image through `image.confirm_description` (web
`imageProcessing.confirmDescription`) with `id`, `contentHash`, `description` and an operation UUID. It
is text-only and bound to the content hash under the Image row lock; a retry returns its committed
effect, and a write whose `expectedEffectId` no longer matches the current confirmation is refused.
Claims, nutrition and cutout eligibility stay model outputs. Image-analysis retries publish the first
retained result for that analysis identity in `AiAnalysis`; later responses and model analyses never
replace retained evidence, write confirmation columns or acquire text authority. Description
authority disappears with the Image.

### Suggestion cells

Cells and fact rows show one saved state: a value looks the same whoever set it, and lists ask no
model. A below-bar answer for an empty or Cubby-held field is a guess: `suggestion.fieldGuess` returns
the active pending Suggestion whose live input fingerprint still matches, and the field's picker shows
it as a pinned "Cubby's guess" group (with the runner-up when stored), never selected; Enter with an
empty search picks it. Choosing the guess accepts that Suggestion; choosing another value is an ordinary edit,
recorded as the correction. A person-held field has no guess.

Edit forms ask live on their unsaved basis. A live decline (`none`) or `no_signal` answer is remembered
per basis and the field's decision-policy stamps, with a signature of the inputs it read; a later
decline of the same question replaces it. Each remembered question's inputs are re-prepared from
saved data without the model or paid providers, so a changed roster, linked record or stock tally
reopens it like a basis edit; inputs needing a provider (a cold query embedding) cannot be verified
and are asked live under a fresh revision on every read. A reopened question's live ask carries the
read's input revision (prefixed by the member review that marked the decline a miss, if any), so
answers cached for old inputs are not reused. Replacements are serialized per question; the newest
memory row wins. Outcome variants keep optional `reviewStatus: "rejected"` when a member rejection
withholds a proposal. First reads return known skipped states (`no_signal`, `no_candidates`,
`resolved`) without inventing history. Questions with saved finance context (`entityId`),
pinned-model replays and member-marked misses are always asked again.

Every field-suggestion review surface opens the same body (`entity/suggestions/suggestion-body.tsx`):
Accept / Reject (with "Use a different value…"), confidence as "92% · high" (`formatConfidence`), the
runner-up and its probability, the basis fields read, and a provenance caption (model, Run, time, AI
usage). Jev and Clef return no prose, so those facts are the reasoning. A tree suggestion keeps the
model's selected category and confidence; ancestor probability never substitutes for a leaf decision,
and ancestors of the current category stay suppressed as corrections. Percentages describe model
confidence, not correctness. Suggestions stay available to evaluation after review.

Classification suggestions choose existing taxonomy references from metadata and retained
original-image evidence; confirmed description corrections outrank model text. Taxonomy contents are
part of the proposal basis, so vocabulary changes invalidate old proposals without rerunning vision or
an inference cache. Hierarchy-aware placement keeps a selected leaf when it carries at least 80% of
the first ancestor branch whose summed probability reaches 0.85; otherwise that ancestor is proposed,
and an already selected parent can use its subtree probability. A kept leaf keeps its confidence.
Proposals never replace a saved specific category with its ancestor because branch probability is
high. Current target values participate in requests and drift checks; sibling corrections,
refinements and broad classifications for empty fields stay available. Stored category corrections
wait for the current hierarchy projection before cell or bulk acceptance, and stored ancestor
downgrades are withheld. Suppressed live ancestors report a non-pick outcome with no decline
probability, so outcome summaries never count them as proposed changes.

### Sweeps

Entity lists expose a generic pending-suggestion filter (any, Addition or Correction) and can start a
Sweep across every declared target using the list's active filters. A Sweep freezes matching
record/field membership and its selected model at launch and returns a Run immediately. Background
Workflows resume from durable target receipts, rechecking current values and member field writes
before publication. Pause and resume use Run status; transient failures retry within a bound and
terminal failures stay visible. Paired trials and finance acceptance rules stay part of the workload.
Identical pending targets can share execution while each requesting Run inspects the published
Suggestions and keeps its own receipt. No-proposal evaluations count as completed work without
increasing the queued count. Field publication builds an entry for `publishSuggestions`, whose
immutable-key replay check also owns the field Sweep write.

### AI field refresh

The deployed AI refresh manifest compares exact per-feature prompt/policy versions, including
rollbacks; the [AI refresh runbook](runbooks/ai-refresh.md) owns activation, observation and recovery,
and [Jobs](jobs.md#ai-evaluation-drains) owns the drain. Its Run-backed `AiEvaluation` ledger targets
fields and Emails and admits one queued slot per feature, entity, record and field. Changing evidence
updates queued input and its Job in place; executing input stays frozen with at most one queued
successor; settled reverts create a new attempt served by the AI response cache. Declined attempts
are bounded per input, and member cancellation vetoes automatic readmission
([Jobs](jobs.md#producers)). The ledger fences publication against the active generation, Workflow
attempt and target-field audit revision; a member edit returning a field to its earlier value still
invalidates the outstanding result. Discovery revisits uncertain unresolved Emails, pending
Suggestions and input-invalidated or no-proposal field work when the fingerprint changes; settled
confident Emails and member resolutions keep their domain authority. Applied field targets,
including inactive saved-form applications and rejected corrections with application receipts, are
reevaluated when evidence or policy changes.

#### Field authority and automatic writes

`AuditLog.authority` records who holds a field after a write: `automatic` for an Automatic rule's
field write, `released` for a member's Let Cubby decide, null for a member, import or agent write.
`fieldAuthority` reads the newest update audit row naming the field: no row and an empty stored value
is `open`; `released` is `open` or `cubby`; `automatic` whose `to` equals the stored value and whose
applied Suggestion no member kept (a member `correct` decision) is `cubby`; anything else, including a
value set at creation, a timestamp tie or an out-of-band write, is `person`.

The automatic gate saves an answer at 85% or more for an `apply: "auto"` fill field with supporting
basis evidence, complete current dependency stamps and a current input fingerprint, when the holder is
`open` and the effective value is empty, or the holder is `cubby`. Cubby never writes a `person`
field, an explicit None, a value rejected for that record and field, or a `fillOnly` field it already
filled. A replacement of a Cubby value needs a 0.20 lead over the runner-up, and a value Cubby already
replaced is never applied again. `apply: "review"` answers wait for a member; `apply: "offer"` answers
wait as the field's picker guess. Fields are asked only where their classification admits them: an
unclassified record is not asked a field its classification refuses by default.

An edit of a Cubby-set value is the correction: the field-automation drain records a `wrong` decision
with the right value on the applied Suggestion and rejects it. An import or cron replacing it records
nothing. `suggestion.fieldAuthority` keeps a Cubby value (it becomes the member's), clears a wrong
one (the field empties as `released`, the value is ruled out) or releases a person's value.

#### Field automation triggers

Field evaluation follows events only. Every create and update audit row of an entity with automated
fields is written with `automationPending`; the `field-automation` drain reads them oldest first,
records corrections, rechecks up to 25 similar Cubby-held values after a signed-in member's
correction (records holding the value Cubby got wrong first), and schedules evaluation of open or
Cubby-held fields whose basis or backing keys changed, every such field of a created record, and a
released field. A row Cubby wrote never re-triggers its own field. A full automatic backlog leaves the
remaining rows pending. After an activation revision the drain's policy unit re-asks every pending
guess and Cubby-held value once, paging by record and field. Page views schedule nothing and there is
no periodic pass. Records nobody writes are evaluated by a member-started Sweep.

Saved-record evaluations prepare evidence from the saved entity and carry up to eight precedents:
values a person set for the same field on records sharing a reference-valued basis key, corrections
of Cubby first. Cubby-set values are never precedents. Interactive form predictions ask live on the
unsaved basis, stay inactive and never schedule automatic writes.

A Suggestion's mutable columns keep the latest evaluation's input and policy beside its application
metadata whenever nothing replaces it, including when an exact wrong review or value suppression
filters every proposal. Reconciliation may advance a revision once after application; settling the
current basis lets discovery skip preparation. Deleted subjects are skipped. Write and input fences
reject edits during inference and later writes in the same application transaction, including ABA
edits, before capturing the settled post-application fingerprint. Rejected proposals without receipts
stay resolved; eligible unknown provenance is evaluated once. Successful ambiguity or missing evidence
is terminal for that fingerprint; transient or interrupted inference gets three attempts. Two
independent refresh targets may run globally, with dependent calls sequential. An execution claim
defers immediately when global admission is busy, keeping queued work and its attempt count for the
Workflow retry instead of holding an origin connection in a lock wait. Publication locks Runs before
evaluation items and takes the activation share lock only at its final commit fence; a deactivation
or generation change refuses or rolls back the write. Prepared evidence never replaces the
transaction's current Run authorization or activation checks. Email Runs freeze at most 200 items and
run only while Mail import is on for that mailbox; reused Email stages require the current source
checksum and feature provenance. Independent model grading and member labels follow the
[decision-grading skill](../.agents/skills/decision-grading/SKILL.md).

### Automatic semantic classification

Automatic semantic classification uses declared Decision features: receipt roles, UPC offer
comparability, weak image provenance and Product title variants. Authoritative assignments bypass
inference. Valid uncertainty abstains without inventing a value; provider and malformed-response
failures fail the operation. Classification is prepared before business publication, which rechecks
evidence and stronger assignments. Changes apply when workflows next run; existing classifications
and cached lookups are not reclassified automatically. Image source Decisions record `sourceEvidence`
separately from capture evidence and establish no photographer, capture time or location; manual,
strong sighting, import and meaningful EXIF evidence outranks weak metadata, and processed metadata
without capture facts or weak library membership never establishes ownership alone.

Exact retained source claims publish rule Problems independently of model availability. Registered
identifiers keep their single owner: only accepted originals with actual Product bindings establish
additional claims, while shared model/style names, URLs and partial variant text stay retrieval or
recommendation evidence. Retained claim loads resolve issuer ownership from one operation-local Vendor
and source-registry read, return each accepted receipt once with its current live bindings in one
statement, validate the complete receipt and keep binding order. A line whose issuer cannot resolve
(an ambiguous host, incompatible ownership, a non-HTTP page) drops only that claim, recording the raw
error, Product and page in the evaluation result's `coverage` beside whether vector neighbour
retrieval was queried, unconfigured or failed. Semantic relatedness and identity share one page
resolver that validates selected seeds and returned physical hits, hydrates canonical text at most 100
artifacts at a time, keeps only current metadata in its page-local cache, and checks completeness
after live validation.

Product Category describes identity and can supply a Spending category mapping through its ancestry;
Cost type describes the Expense's accounting role; Trade describes work context; Product Category
does not infer Trade. Reviewed Product category reassignment previews historical spending,
fingerprints selected Products even without Expenses, and revalidates before audited transactional
writes; explicit Expense categories and Purchase defaults keep precedence. Food feature transitions
require a broader Project/Trade review and are refused by the spending-only workflow; identity
normalization cannot substitute a target different from the reviewed one. Lazy field explanations
return bounded hierarchy and fallback-source evidence so clients never reconstruct these rules.

## Field explanations

Resolvers return the selected value and its evaluation trace together. Traces distinguish used
sources, unresolved decisions that block fallback, absent or disabled sources that permit fallback,
and alternatives evaluated but overridden. Observed inputs keep source links and current policy
settings and never invent historical intent. Coverage reports shown and omitted rows, inventory
branches and inputs. Each independent contributor holds its own chain, typed decision steps and
coverage; row indexes address that chain, including its summary row. Ownership evidence includes at
most 50 inventory contributors, 50 decision steps per chain plus its summary row, and 50 observations
per step; record labels batch-load across visible contributors. Evidence and authoritative resolution
are read in one snapshot; clients never reconstruct precedence. Stock-tracking resolutions keep their
evaluated category chain and fallback source even when a Product override wins; category
stock-tracking SQL materializes its deciding source and ladder once per expression. Quality
explanations render published check states with current exception controls without recomputing or
comparing a cached result.

Web explanations keep one compact hierarchy across quality, derived values and inheritance: result and
interpretation lead, then applicable checks and source evidence, then technical metadata. Check rows
distinguish missing data, defects and accepted exceptions with labeled badges; weights and caps stay
inline; check ids and raw evidence live in Technical details (collapsed by default). Satisfied checks
collapse into a green labeled summary; gaps use amber and defects red, with labels carrying meaning.
Repeated owner gaps show once; related-record gaps stay separate. Inheritance ladders align source,
value and precedence, wrap long values and emphasize the winning source. The same evidence view serves
populated and empty fields on list and detail. Observation `fields` name declared source fields whose
own explanation and controls sit beside the record link. Editable stored fields get a direct-value
explanation; native detail keeps explainable empty fields.

Resolution order uses the shared records block's `timeline` presentation for precedence, not
chronology. Every nonempty chain stays visible, including a single subject or steps without links.
Explanations include unset candidates and overridden fallbacks; allocated values expose contributing
records with their own expandable chains. The server supplies the outcome so mixed contributions,
unset values and blocked mappings never collapse into one null display; intentional domain nulls keep
their labels. Clients collapse long chains and contributor lists and disclose bounded evidence even
without ordinary source rows. Structured evidence owns the readable value; never repeat its raw object
underneath. Owner rollups show one readable row per Inventory entry. Reset and navigation actions stay
in the popover footer, which stays inside the scrollport to keep phone touch targets; exception
actions stay with their check. Tables keep compact rows and lazy explanations. Nested evidence
switches from aligned facts to stacked labels by its own container width.

Generic evidence values link validated HTTP(S) URLs, format ISO timestamps in the household zone, and
use calendar-date context for plain dates. Bounded evidence ids resolve in one identity batch to
public codes and shared entity links. Identifier source links use the registered
`ExternalSource.vendorId` owner, including host-based slugs; a slug's spelling never establishes Vendor
ownership. External identifier values stay literal even when they match an entity UUID, public code or
source slug; unregistered row ids and unowned slugs stay literal.

Product Owner explanations expand each inventory entry's assignment and acquisition stack.
Acquisition-only owner labels say "from purchase"; purchaser, beneficiary, funder and account holder
keep separate roles. Entirely unknown beneficiary shares permit account defaults; partially named,
conflicting, split named and named Household attribution keep the blocking semantics owned by the
terminology guide. Unknown ownership is not explicit Household ownership.

Product Locations keep their links and add a server-composed inventory status combining tracking
policy, installed Location presence, recorded acquisitions and exits, and comparable inventory
counts. No quantified history differs from a supported zero balance; unknown kit quantities keep
history incomplete. Exact discrepancies require complete quantity history and inventory in each unit.
The variance column, SQL filters and sorts, picker/recount summaries and location captions share that
comparability rule. No status implies automatic consumption or disposal, and disabled tracking never
removes manual inventory. Declared relation sections may place unique detail `contextFields` above
their table (Stocked at uses this for the status and its evidence). Native default list rows include
relation context fields marked for list display even when the web column is hidden.

## Adding an entity

1. Add one typed `.entity.ts` declaration with field validation, storage, mutation policies,
   presentation and capabilities through `defineEntityModel`; export its `definition` and
   `readSchemas`, then construct relationships with `defineEntity`. The bootstrap discovers the source
   body automatically. `presentation.titleField` must resolve to a non-nullable text read field; if
   the natural title can be empty, declare a storage-less read-only `displayName` field
   ([Presentation metadata](#presentation-metadata)).
2. Declare the table's indexes, checks and Drizzle relations in `storage`. Ids use
   `EntityId<"entityKey">`; named aliases need no enrollment. Omitted `fields` refs compile raw
   contracts from `readSchemas` and field validation; standard public schemas live at
   `@cubby/schemas/entities/<entityKey>` with no façade or export roster. Override refs only for
   domain refinements or distinct projections; explicit null disables that operation. Stored JSON
   types that differ from public values belong on the storage entry's `type` ref. A physical change
   needs a migration carrying existing rows; a new shortcode table's migration must backfill `Entity`.
3. Ordinary stored declarations need no repository module: the generator constructs the scaffold,
   CRUD writers and `defineRepository` binding from their contracts and table. Unsupported ordinary
   writes, unbound raw read projections or required domain SQL bindings fail generation. Declared
   rollups and published-result projections use their shared SQL plans. An explicit
   `extensions.ports.repository` overrides this for concrete domain rules or projections, with the
   reason beside it. Ordinary search reads use the stored title and public text fields; a distinct
   search projection binds `extensions.ports.search.read` without a repository wrapper (TransactionImport
   uses the default repository with a declared record-count rollup and keeps its search port). Public
   non-identifier reference values keep their stored form, including source slugs.
4. Set `route.basePath` for the generic pages (`route.list: null` hand-writes the list module; detail
   is always generic, with specialized UI in detail slots); add workflow extensions where needed.
   Every `many` relation gets a detail table and every FK a derived inverse unless omitted with a
   reason (`detail.omitRelations`, `inverseOmit`).
5. Run `pnpm generate`; review generated source like hand-written source.
6. Constrained entity-id storage references compile physical incoming edges with the `reference` role
   and `must-target-live` liveness; ordinary edges block deletion and merge while live references
   remain, without target-side enrollment. `ENTITY_EDGE_OVERRIDES` owns explicit domain semantics,
   which still require exhaustive operation policies; financial, ownership, history, child and link
   semantics stay explicit. A new shortcode table gets its identity FK and shortcode index generated,
   and its writer uses the shared transactional identity helper. A new join or child table carrying
   an edge column names its owner in `ENTITY_EDGE_OWNERS`. A new many-to-many pairing is a kind in
   `ENTITY_LINK_KINDS`, not a new table.
7. Run generated action contracts and the affected PostgreSQL contracts, plus UI and built-browser
   checks for changed presentation; follow the [validation guide](agents/validation.md) for final
   gates.

The compiler owns mechanical catalogs and capabilities; repositories keep hand-written transaction
seams until their ports can be generated without weakening domain invariants.

## Related records

`extensions.relatednessSignals` is the static opt-in for the shared detail-page Related records rail
and `relatedness.forEntity({ entity, id })`. Every entity with semantic search declares a same-entity
semantic signal (label, weight, candidate limit). Product, Recipe and Location also declare stored
tag overlaps as display-only evidence; popularity caps omit ubiquitous tag hubs. Generation rejects
signals on entities without embeddings and overlap fields that are not stored text arrays; no
entity-keyed runtime registry exists. The scalar reader names its CTE `candidate_overlaps` because
PostgreSQL reserves `OVERLAPS`.

The semantic reader shares source readiness, current-vector validation and hit hydration with explicit
similarity search. Unavailable, uncomputed and stale indexes stay visible rather than masquerading as
empty; an explicit Index now action uses the embedding refresh operation and a bounded readiness poll.
Related records never publish suggestions, merge identities or mutate records. Scalar-only candidates
stay visible with zero score; semantic weights decide ranking. Evidence merges once per public record,
ranks deterministically, and batch-resolves images for visible rows. The rail is a shared indexed
detail section loaded on visibility.

## Household maintenance view

Task's Maintenance saved view is pinned on Home and opens its declared web list slot. Membership is
explicit project-name search: effective Project names containing `maintenance`, case-insensitively;
the visible project-name filter can narrow it. Productless chores use the same Tasks as appliance
work; there is no separate maintenance Activity entity.

`Task.completedOn` is an optional, member-recorded calendar day, independent of `due`. Create, update
and the ordinary editor carry it through HTTP and MCP; omission preserves it and null clears it.
Historical values stay unknown. Completion status, a deadline, purchase date or `updatedAt` never
supplies a completion date. Reopening a Task keeps its recorded date, but only done Tasks contribute
cadence evidence.

`task.maintenanceHistory` returns exact-title, same-effective-subject groups across years, with no
normalization, semantic matching or fuzzy merging. Distinct same-day completion dates count once; the
observed interval is the median positive interval between dates; one date is insufficient history;
undated completions are counted and excluded. Supporting dates and interval counts stay in each row's
History disclosure. Groups without a recorded date stay in Completed work and contribute to one undated
summary. The view keeps task lists short and paginated and folds Project browsing below spending. This
describes observations, not a recommended service interval, deadline, recurring schedule or stock
assertion.

The spending-year control filters only the ordinary Expense list, by allocation shares into the
matching Projects and Expense date; history stays cross-year. Task editing and completion, Project
browsing and Expense assignment reuse generic embedded lists. Project spending never claims an exact
Task-to-purchased-part connection. The native slot hands off to web; shared fields and the MCP read
use the same contracts. Opening the view triggers no background work, purchases or inventory changes.
