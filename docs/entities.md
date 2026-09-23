# Compiled entities

Cubby's ordinary entity surfaces are compiled from typed TypeScript declarations
in `packages/schemas/src/entity-definitions/*.entity.ts`. Each declaration uses
real Zod schemas for read, create, and update modes. The generator imports these
modules and emits references to the declared schemas; it never serializes Zod
internals or reconstructs refinements.

`definition.ts` owns the strict metadata schemas and their inferred declaration
types. `defineEntity` preserves literals without parsing at runtime; the compiler
parses metadata and applies defaults before typed compilation. Cross-entity
references, capability compatibility, field rosters, and physical storage remain
semantic compiler checks. Field-validation Zod instances pass through unchanged.

For generic behavior shared across entities (including #1066 and #1067), add
the capability to the entity declaration first, implement it in the generic
renderer, prove declaration-to-renderer parity, then delete the per-entity twin.
Keep any remaining entity-specific exception explicit in its declaration.

Declarations may import shared primitives and cycle-safe field modules. They
must not import canonical schemas, generated artifacts, server implementations,
or browser modules. Implementation references remain `{ module, export }` data.
Browser metadata is generated separately and contains no executable schemas.

Generated detail and list type maps derive from their schema maps, preserving
the entity key's input/output correlation. These schema-contract artifacts remain
separate from browser metadata and executable server bindings.
A transitive import guard protects this boundary; shared identifier and field
primitives compose domain projections without importing generated schema maps.

Run:

```bash
pnpm generate
pnpm generate:check
```

One generator (`scripts/generator/main.ts`) runs three stages in order: the
entity stage (`scripts/generator/entities/`), the Start operation registry
(`scripts/generator/start-operations/`), and the HTTP OpenAPI document with
its native derivations (`scripts/generator/http-api/`). `generate:check` fails
on invalid metadata, duplicate entity keys or routes, invalid relation
policies, unsupported capabilities, and stale, missing, or extraneous generated
files from any stage. Typecheck verifies declaration types and referenced
exports.

## One declaration, several consumers

Each declaration co-locates schemas and field policy:

```ts
export default defineEntity({
  key: "example",
  names: { singular: "Example", plural: "Examples" },
  route: {
    basePath: "examples",
    // "dialog" puts `?create=true` in the list search and renders the capture
    // action; "page" links a hand-written `examples.new.tsx` as `routes.new`.
    create: "dialog",
    // `true` generates the route module over the generic list/detail page;
    // a `null` list keeps it hand-written. Every detail is generic: the
    // generator rejects `detail: null` outside a two-entity allowlist.
    list: true,
    detail: true,
  },
  table: "Example",
  identifiers: { brand: "ExampleId", shortcode: "EXM-" },
  presentation: {
    titleField: "name",
    domain: "pantry",
    description: "One sentence for the records catalog.",
    emptyState: {
      title: "No examples yet",
      description: "…",
      actionLabel: "New Example",
    },
    icons: { lucide: "Box", sfSymbol: "cube" },
    detail: {
      hero: { chip: "status", actions: ["edit"] },
      sections: [
        {
          kind: "fields",
          id: "overview",
          title: "Overview",
          fields: ["name", "status"],
        },
        {
          kind: "relation",
          id: "tasks",
          title: "Tasks",
          relation: "tasks",
          filter: { descriptor: "exampleId" },
          columns: ["name", "status"],
        },
        {
          kind: "slot",
          id: "analytics",
          title: "Analytics",
          placement: "full",
        },
      ],
    },
    list: { views: ["table", "shelf"], actions: ["delete"] },
  },
  fields: {
    create: { module: "@cubby/schemas/example", export: "exampleCreateInput" },
    update: { module: "@cubby/schemas/example", export: "exampleUpdateInput" },
    output: { module: "@cubby/schemas/example", export: "exampleOut" },
    detail: { module: "@cubby/schemas/example", export: "exampleDetailOut" },
  },
  filters: {
    schema: {
      module: "@cubby/schemas/example",
      export: "exampleFilterFields",
    },
    audit: true,
    descriptors: [
      {
        columnId: "name",
        kind: "text",
        placeholder: "Filter by name...",
      },
    ],
  },
  relations: [],
  search: { enabled: true },
  capabilities: {
    auditable: true,
    images: false, // or "gallery" (an `<Entity>Image` join table) | "cover" (one `coverImageId`) | "logo" (one direct logo FK)
    countable: true,
    softDelete: true,
    delete: { mode: "soft", bulk: true },
    merge: false,
    mcp: ["get", "list", "search", "create", "update", "delete"],
  },
  extensions: {
    countFilter: null,
    relatednessSignals: null,
    mcpNames: null,
    ports: {
      repository: {
        module: "~/server/repo/example/entity-adapter",
        export: "exampleEntityAdapter",
      },
      references: {
        label: { module: "~/entities/entities", export: "entityLabel" },
        resolver: {
          module: "~/server/repo/shortcode-resolver",
          export: "resolveLiveShortcode",
        },
      },
      filters: {
        module: "~/entities/filter-manifest",
        export: "getEntityFilters",
      },
      search: {
        projection: null,
        semanticText: null,
        dependentRefresh: null,
      },
    },
  },
});
```

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
`financialTransaction`, `purchase`, and `inventory` all use this pattern
today. `domain` (a `WAYFINDING_DOMAINS` line or
`null` for an entity on no line), `description`, `emptyState` copy, and icon
names (`lucide` is checked against the browser registry's icon map at compile
time; `sfSymbol` reaches the native catalog verbatim). The generator emits it
as part of `entitySummary` (`packages/schemas/src/generated/entity-summary.gen.ts`,
data only, safe for eagerly-loaded client code), spreads it into the inspector,
and writes `domain`/`sfSymbol` onto the Swift `EntityDescriptor`. Navigation
grouping, the Records catalog, empty states and the native shell's sections
all read it; none of them keep a per-entity list of their own.

`presentation.detail`, `.list` and `.edit` are the one declaration both the
web and the native renderers draw from. `detail.hero` names the chip (an
enum/boolean field), stat fields, a breadcrumb reference field, whether the
gallery renders, and the action verbs; `detail.sections` is an ordered list of
`fields` (a named subset of the `display.detail` fields — every such field is
placed exactly once), `relation` (the target entity's list filtered by an
id/idMulti descriptor on the target whose `brandRef` points back here, with
optional `columns`/`sort`/`limit`), `timeline` (the entity's timeline
capability) and `slot` (the one per-platform hand-written fill, rendered
only where a registry provides it — `DetailSlotId<E>` / `ListSlotId<E>` in
`entity-manifest.ts` type those registries). A relation section may also
declare `hideWhenEmpty: true` to skip itself entirely when its first page
reads empty (web `GenericEntityDetail`/`entity-relation-table.tsx` and native
`EntityDetailView` both honor it; the generator emits it onto the Swift
`RelationSectionSpec`) — used where the section's presence is itself the
signal, e.g. a Location only reads as a growing area once it has Plantings.
`collapseWhenEmpty: true` instead keeps the header, `0` count and create
button and folds only the body away.

Relation tables are opt-out. Every `many` relation on a generic detail page
renders a table: a declared `relation` section, or one the compiler derives
(`scripts/generator/entities/derive.ts`) with `derived: true`,
`collapseWhenEmpty: true` and the target's default columns. The derived
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
#1248's generated predicate serves it with no repository code. Every
id/idMulti filter declares `brandRef` (`null` for an id that names no
entity), so URL-only related-view filters stay usable as back-filters.
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
schema carries `view` when there is more than one. `list.actions`/`links` are
the header verbs and links; `list.timeline` names the date fields and
lifecycle keys the default timeline emits. `lifecycle.start` accepts either a
single field key or an ordered array of them — an interval's start is the
first field in that order with a non-null value, so a fallback field can
supply the start when the primary one was never set (e.g. planting's
`["sowedOn", "transplantedOn"]`: a nursery-bought seedling has no `sowedOn`,
so its interval starts at `transplantedOn`). The default timeline marks such
a row as inferred (`confident: false`) whenever a fallback key, not the
first one, supplied the start. `edit.sections` (`[{ id, title, fields,
collapsed? }]`) is the editor's section grammar: the web `EntityIntentFields`
and the native `GenericEntityEditModel` both bucket the intent's fields by
it, falling back to `control.section` groups when it is omitted. Because the
native editor renders _only_ the fields a declared section lists, the
compiler requires a declaring entity to place every controlled field of its
create/update rosters and edit intents exactly once — the image-block keys
(`pendingImageIds`, `pendingImagePurposes`, `removeImageIds`, `imageOrder`)
are excluded, since the editors' image block owns them on both platforms.
`edit.readOnlyOnUpdate` and
`edit.readOnlyWhen` lock fields in the update editor. `capabilities.timeline`
(`"default"`: audit log plus the declared date fields; `"custom"`: the
`extensions.ports.timeline` implementation) publishes
`resources.<entity>.timeline`. The compiler checks every named field,
relation, descriptor, view and section id.

Every listable entity receives the shared List (`table`) and Cards (`shelf`)
presentations without requiring stored photos. Existing first-view defaults
remain unchanged. Cards use the declared title and `list.shelf.subtitle`
fields, falling back to declared mobile subtitle metadata when no shelf
caption is specified; missing captions stay absent. Server-resolved display
images are reused, with an entity icon when no image is available. Exceptional
list projections use explicit adapters rather than per-card detail requests.
Compact is the same card presentation with screen-local density state, not a
stored preference or a URL parameter. Shared web and Swift grid components own
tile sizing; declarations own record-specific presentation facts. All three
presentations retain the list's query, filters, sort, and pagination. Bulk
selection and editing are available only in List.
`list.viewAliases` preserves retired view URLs by mapping them to a current
renderer. `list.primarySearch` declares exceptional list search inputs without
claiming that the entity participates in global search (for example USDA's
`nameFilter`). Native read metadata distinguishes generated resource readers
from explicitly declared read-RPC adapters; it does not expand `httpActions`.

`capabilities.bulkUpdate` (`{ fields: [...] } | null`) is the only thing an
entity declares for bulk editing — there is no per-entity bulk-edit verb to
write. The web list registers one generic `bulkEdit` action
(`apps/web/src/app/_components/actions/bulk-edit-entity-action.tsx`) for every
entity whose manifest declares it, and its dialog renders exactly those
fields through the same reference/select/date rendering `EntityIntentFields`
uses. The mutation payload is the form's dirty-field subset: an untouched
field is omitted, and a cleared nullable field sends `null`. Native has no
`bulkUpdate` route or multi-select delete.

`capabilities.images` is `false`, `"gallery"` (an ordered `<Entity>Image` join
table, bound in `apps/web/src/server/repo/database-helpers/crud.ts`
`imageJoinBindings`, whose keys are checked against `GalleryEntity`),
`"cover"` (a single `coverImageId` column, cookbook), or `"logo"` (a single
direct logo FK, vendor). The manifest keeps the storage boolean `hasImages`
(`gallery`/`cover`) alongside `imageStorage`. Every public entity list and
detail read carries server-resolved `displayImages: [{ id, url }]`; details
also carry directly owned `attachments` with their role and position.

Image-ingress bindings use `source-id` for a singular reference target and
`source-id-list` for a multiple reference target. Both are compiled against the
declared reference cardinality; no image workflow branches on a domain field
name to decide whether the source identity is wrapped in an array.

Related display images come only from explicit domain relationships and never
recursively consume another entity's resolved `displayImages`. The centralized
resolver in `apps/web/src/server/repo/entity-display-image.ts` orders direct
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

The model owns scalar validation and physical column factories as well as
presentation. `model.storage` declares stored columns; `create`, `update`,
`output`, `bulk`, and `audit` select fields for their respective consumers.
The generator emits field schemas and storage factories; canonical schemas
compose those generated fields with explicit relationship and domain validators.
Each `entity-field-schemas.<entity>.gen.ts` map is `fieldSchemasOf(definition)`:
the create/update/read schemas are read off the declaration by roster key at
load time (never by field index, so a mid-roster insert cannot shift another
field's schema) and are the declaration's own Zod instances, which is what the
field-map-drift test checks.
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
    display: { list: true, detail: true },
    validation: {
      read: z.string(),
      create: z.string().trim().min(1),
      update: z.string().trim().min(1).optional(),
    },
  }],
  storage: ["name"],
  create: ["name"], update: ["name"], output: ["name"],
  bulk: [], audit: ["name"],
}
```

Field defaults are non-nullable, a label derived from the camel-case key, and a
read key equal to that key. Use `readKey: null` for fields without a scalar read
projection. Missing controls and display flags expose no UI. A control defaults
to the `main` section; a reference defaults to one entity. Explicit labels,
nullability, read keys, sections, and renderers override these defaults.

A reference may declare `multiple: true` and an ordered `scope` mapping. Each
scope item maps a sibling form `sourceField` to a filter `targetField` on the
referenced entity. The compiler verifies both ends and generated editors wait
until every scoped source has a value before querying, so an incomplete form
does not accidentally widen the candidate set. Scope constrains discovery,
not stored values: existing selections remain visible and can be removed even
when another field changes and they no longer match the candidate query.

`control.suggest: { basis, mode }` marks a field whose value the decision tier
(Jev) infers from named sibling fields, so the browser editor can auto-fill it
while untouched and offer a one-tap apply once a value already exists. `basis`
names model field keys on the same entity only — never an `intents.editorFields`
pseudo field, since detail/table/bulk surfaces have no editor-field data to
read. `mode: "fill"` (the default) targets a select-controlled enum, a singular
(non-multiple) reference, or a nullable text field (a roster-backed name, e.g.
`expense.vendor`); the compiler rejects anything else, a basis key that doesn't
resolve to a model field, a basis key naming the field itself, and any cycle in
the basis → target edges across an entity's suggest fields, so one request can
always resolve every target in dependency order.

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
(record surfaces — list/detail — request them).

The generated `suggestFieldKeys` tuple
(`packages/schemas/src/generated/entity-field-model.gen.ts`) lists every
declared `"entity.field"` suggest target, and its `GeneratedSuggestFieldKey`
union type-enforces that the server's field-suggest registry carries exactly
one entry per key.

An omitted or null mode has no schema. Zod owns optionality, transformations,
nullability, descriptions, refinements, and defaults. Put create-only defaults
only on create schemas, and make partial update schemas explicitly optional so
omitted values preserve existing data. Schema maps reference these exact objects.

A storage string uses the declared field's kind and nullability, the key as its
column name, and no database default. An object such as
`{ key: "name", column: "title" }` overrides only the differing storage facts.
Stored-field order and create/update/output/bulk/audit rosters remain explicit:
presentation defaults never grant mutation capabilities or introduce columns.

The `model.fields` roster owns field kinds, read keys, labels, validation,
controls, and display membership. `EntityBasicInfo` reads `display.detail`;
`createEntityDisplayColumns` reads `display.list`. A field's
`display.renderer.list` or `display.renderer.detail` selects a semantic
renderer while the declaration continues to own membership, labels, ordering,
and widths. The generator emits narrowed TypeScript renderer IDs and Swift
renderer enums. Each platform keeps an exhaustive registry that marks every
declared renderer and slot as implemented, generic, owned by its container, or
unsupported with a reason. Executable queries, runtime option providers,
heterogeneous trees (rows of another entity nested under a row), dialogs, and
workflows remain handwritten. A self-referencing tree is declared:
`presentation.list.tree.parentField` names a readable single reference to the
entity itself, and the generic list nests rows under it, keeping a row whose
parent is not loaded at the top level. A legacy field override and
a manifest renderer may not claim the same surface; the compiler or registry
test fails instead of choosing one silently. `control.renderer` follows the
same contract for form controls. `display.columnId` preserves an existing computed column identity when
it differs from the field key (for example an evidence count); active list
column IDs must be unique. An override must match a declared list field; an
unmatched override fails instead of silently hiding the column. Computed
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

`display.detailOrder` optionally orders detail facts independently of model and
list order; it must be a nonnegative integer. Unspecified facts retain model
order after explicitly ordered facts. `display.listOrder` does the same for
generated list columns (model order also drives form field order, so it cannot
be re-sequenced), and `display.columnId` keeps a persisted column id when the
field key differs — ids are saved layouts, filter bindings, sort ids and
saved-view keys, so a rename is never free.

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
declared `list: true` scalar rendered by `createEntityDisplayColumns` with no
code. A declared column with a named renderer is rendered by the platform's
manifest registry (a badge, a link, or a relation label) and retains the
declared label and sort. A legacy override remains only as a migration seam for
specialist columns not yet manifest-owned. An explicit
`add()` outside the declaration is reserved for client-hydrated data, relation
projections, a second projection that hosts a filter control, and the
synthetic identity column. A `list: true` field with `readKey: null` needs an
override; column compilation fails otherwise. `display.listHidden` owns a
declared column's hidden-by-default state; pages retain
`initialColumnVisibility` only for computed or relation columns outside the
field model. Detail overrides may provide a dynamic
label when the value changes its meaning, such as ISBN versus UPC. Static labels
remain declared. `EntityBasicInfo.afterFields` anchors computed facts after a
declared detail field without inventing persisted fields or API contracts.
Unknown detail override keys and computed-fact anchors fail explicitly.
`EntityBasicInfo` takes a declared `fields` section's keys
(`entitySectionFields(entity, id)`) instead of a local field subset, so the
declaration owns each section's labels and membership.

`model.sort` owns the declared list-sort roster: `fields` (the ordered, complete
sortable-column list), `default`, and optional `groupable`/`computed` subsets.
Every `fields` entry not named in `computed` must be a `model.fields` key; a
`computed` entry names a roster key with no scalar read projection — a
correlated subquery or rollup resolved in the repository, such as a vendor's
live purchase count or a product's expected-quantity variance. The generator
emits the roster as `generatedEntitySort` in
`packages/schemas/src/generated/entity-sort.gen.ts`, and the kernel's
`defineEntityAdapter` derives its `EntitySortContract` from that map when a
binding omits `sort` explicitly, so an entity adapter no longer hand-lists its
own `sort: { fields: xSortableFields, default: "..." }`. The compiler enforces
`default ∈ fields`, `groupable ⊆ fields`, and `computed ⊆ fields`. The same
roster narrows the `/api/v1` list route (`sort` refined to `fields`, `groupBy`
an enum of `groupable`, or of `fields` when `groupable` is empty), so a
`groupable` entry must stay an identifier the Swift generator can name.

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
expands the standard created/updated date filters. SQL predicates remain explicit
in repository filter builders.

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
is `field ?? columnId`. `text` derives an optional string (or the model
field's read schema with `schemaFromRead`), `boolean` an optional boolean,
`presence` the shared presence filter, `select`/`multiselect` `oneOrMany` of
the read schema (`schemaFromRead`), a named enum export (`schemaRef`), the
static option values, or a plain string, and `range` the shared min/max or
from/to fields, with the numeric/date kind inferred from the model field
(`range.kind` overrides; `range.int`/`range.nonnegative` tighten it). A
declaration module must not export `filterSchemas`.

Generated artifacts provide the exhaustive entity keys and traits, public
shortcode contracts (the inbound-only `P-`/`L-` label aliases live only in
`packages/shared/src/shortcode.ts`, never in the manifest), schema bindings,
client-safe inspector metadata, browser route roster, the typed list search
schema per entity (`entities/generated/entity-search.gen.ts`: manifest filter
keys, table keys and `create`, with `defaults` naming every key for
`stripSearchParams`), kernel and MCP action capabilities, relation-specific
command schemas, repository/relation-adapter assembly, and contract cases.
The list and detail route modules an entity declares through `route.list` /
`route.detail` are generated too (`routes/_authenticated/<basePath>.index.tsx`
and `.$shortcode.tsx`, with the generated header); a `null` slot keeps that
module hand-written, composing route-only keys onto
`entitySearch.<entity>.schema.shape`. Every entity's detail is the generic
page: an entity outside the kernel detail roster (no create/update contract —
image, cookbook, the read-only Run) declares `detail: { query }`, and the
generator rejects `detail: null` except for `recipe` (its route still renders
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

## Runtime interface

All generic entity work enters through `executeEntity(context, command)` in
`apps/web/src/server/entity-kernel`. It owns:

- public-id and Zod validation;
- capability checks and normalized pagination/sorting;
- baseline get/list/create/update/delete/merge/search commands;
- declared attach/detach relation families;
- in-transaction search projections, then post-commit object cleanup and
  best-effort background task publication;
- one normalized delete result with public references and affected-edge data.

Repositories own database access, transactions, invariants, and the exact
mutation order. Workflow services own operations that are not entity CRUD, such
as expense splitting, reconciliation, cookbook import, and product enrichment.
Extensions delegate to those services instead of branching inside the kernel.

## Transports

TanStack Start is the browser entity adapter. Generic detail, list, deferred
filter-option, and write operations use authenticated Start functions and
generated entity-to-input/output maps. Image, USDA Food, and Cookbook retain
explicit browser projections because their shapes are specialized, but those
projections use the same Start operation module for authentication, validation,
errors, cancellation checkpoints, tracing, and console observability. Every
entity browser operation uses this Start transport.

Ordinary browser calls share `/_serverFn/dispatch`. The global Start fetch hook
adds validated `operation` and optional `entity` query labels for DevTools;
dispatch still reads the validated POST body. The previous production dispatcher
path is internally rewritten at both server entries for already-open clients.
SSR invokes the operation locally without fetching this URL.

The server operation boundary chooses one database adapter before invoking a
handler and exposes that adapter through both context handles. Ordinary queries
across browser, native, HTTP and MCP use Hyperdrive's bounded-stale binding when
the shared household freshness object reports no write in the last 90 seconds.
The server-owned strong-read registry retains credentials, interactive inventory,
import preparation and diagnostics. Mutations and mutating workflow streams
remain authoritative, including their internal reads. HTTP methods do not decide
policy: a query transported through POST is still cache-eligible. Each MCP tool
execution selects a new caller from the same freshness state. Availability reads use the selected database; recipe repairs and
their immediate follow-up reads remain strong.

Workflow operations are explicit Start functions with no entity business logic in
the transport adapter. Removing an operation has no deployment shim: a tab loaded
before that deployment must reload before calling the removed function.

MCP invokes `executeEntity` directly through the `entity` tool and publishes its
machine-readable contract at `entities://catalog`. The `get_entities` capability
uses the same generated get/list/search contracts with mutation actions excluded
by its input schema. Workflow-shaped MCP tools remain separate. MCP, jobs, repositories, entity modules, and kernel tests must
not import browser transport modules. Explicit workflow adapters and typed JSONL
stream routes are the only transport seams; business behavior remains in
workflow modules.

## Filters and search

A filter declaration compiles its Zod-field binding and canonical URL keys used
by shared route search-parameter assembly, inspector metadata, and generated
contract cases. Static and deferred controls still live in the explicit filter
catalog; compound presets retain explicit codecs and option loaders. SQL
predicates remain repository behavior and are checked through the real-query
differential matrix—the compiler does not infer database behavior from a URL
key, except for descriptors declared `stored`.

A `stored` descriptor names the standard predicate over stored columns, and
`declaredFilterPredicates` composes it for the repository: `stored: true`
reads the column named by `columnId`; `stored: { columns }` lists one or more
stored fields when the descriptor id is virtual (`search`) or a text match
spans columns (ORed, a `text[]` column matched by element); `stored: { array:
true }` marks a multiselect over a `text[]` column as an overlap. Enum filters
OR their declared `nullable` presence in, a boolean over a nullable
non-boolean column reads as presence (`true` is NOT NULL), and ranges are
inclusive bounds. The compiler rejects every other shape. Predicates that
join, OR across filters, or resolve ids stay hand-written next to the spread,
with a comment saying why.

Searchable entities use persisted `SearchDocument` rows for lexical and
embedding input. The spec generates search capability gates, while projection
SQL and embedding loaders remain explicit because several entities need joins,
aggregates, and workflow-specific text. The kernel refreshes an entity's own
projection and its fan-out projections inside the write transaction; a change
to projection SQL itself does not rewrite persisted rows — run the streaming
"Repair index" maintenance action after such a change.

## Data quality

`capabilities.dataQuality` on an entity definition
(`entityDataQualityMetadataSchema` in
`packages/schemas/src/entity-definitions/definition.ts`) declares
`checks[{id, facet, kind, weight, label, message}]`, `exceptions` (true where
the entity may record `DataException` rows), `related` (other
scored entities whose gaps roll up into this one), and `listOrder`. `id` must
be globally unique across every entity's checks — it doubles as the `dataGap`
filter option value.

The compiler (`scripts/generator/entities/data-quality.ts`) synthesizes two
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
message maps, `dataQualityFacets`, `relatedDataQualityEntities`,
`dataQualityExceptionEntities`, and `scoredEntities`; `data-quality.ts`
composes the public schema from that leaf.

Every declared check id needs exactly one binding in the web registry
(`apps/web/src/server/repo/data-quality/checks/<entity>.ts`), typechecked two
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
`100 × satisfied expected weight / expected weight`, 100 when nothing is
expected — the same arithmetic the hydrated `score` uses, so `ORDER BY`
agrees with the read value. The score is unindexed — a correlated `EXISTS`
per check per row — which is fine at household scale. `related` roll-ups add
an `EXISTS` against an aliased related table using that entity's own
bindings; `list-scaffold.ts` binds the resulting filters and sort for every
scored entity's list in one place.

Durable "not available" exceptions (`set_data_exception`/
`clear_data_exception`) live in the `DataException` table, keyed by an
`Entity(id, kind)` FK, for every entity whose declaration sets `exceptions`.
Enabling it requires fingerprint inputs for every check and an allowed-reason
list per check (`EXCEPTION_REASONS` in `repo/data-quality/exceptions.ts`). An
exception goes with its entity when the entity is removed or merged away.

## Relations, deletion, and merge

Every logical relation declares its target, cardinality, primary named source,
provenance path, and inverse path. A relationship may add more named sources;
for example, `Purchase.products` combines detachable `explicit` evidence from
`PurchaseProduct` with non-detachable `expense` evidence from acquisition
Expenses. Mutable sources additionally name a typed item schema, adapter, and
transport exposure. The compiler rejects duplicate relation/source keys,
unresolvable mutation sources, invalid inverses, and stale generated bindings.

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
collision rules.

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

The physical graph is composed at read time from `ENTITY_EDGES` and
`ENTITY_EDGE_OWNERS` (`repo/entity-edge-source.ts`): `(edgeKey, sourceKind,
sourceId, targetKind, targetId)` with both ends live. It backs the Relations
tab's Connections, the impact preview, the graph explorer's physical edges,
the Problems orphan finder, and MCP `get_entity_connections`. Writes never go
through it.

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
`ImageSighting` records each report that a stored Image appears in one Ledger
Party member's photo library or cloud asset store, from one reporting
`Device` — unique per `(imageId, ledgerPartyId, assetKey)`, so a member's
second device reporting the same synced asset updates the existing sighting
rather than creating another one. `deriveImageCapture` reduces an image's
live sightings, and failing those its embedded EXIF, to Image's own
`capturedAt`, `captureLocation`, `capturePlaceName`, `captureDeviceLabel`, and
`capturedByPartyId` fields, recording how confidently in
`captureAttribution` (`none`, `derived`, `ambiguous` when several members'
evidence ties, or `confirmed` once a member sets it by hand — confirmed is
never recomputed). Every sighting create, update, or delete re-runs this
derivation for its image in the same transaction. See ADR 0005 for the full
precedence rule.

## Adding an entity

1. Add one typed `.entity.ts` declaration with field validation, storage, mutation
   policies, presentation, capabilities, and logical relationships.
   `presentation.titleField` must resolve to a non-nullable text read field;
   if the entity's natural title can be empty, declare a storage-less
   read-only `displayName` field instead (see above) and point `titleField`
   at it rather than at a nullable name column.
2. Add its branded id and compose its table and canonical input/output schemas
   from the generated factories. Keep indexes, constraints, domain refinements,
   and relationship projections explicit. A physical change still requires a
   compatible migration; generation does not apply production DDL.
3. Add a kernel repository adapter for the capabilities the spec declares.
4. Set `route.list` / `route.detail` to `true` for the generic pages (a
   `null` list hand-writes its route module; detail is always generic, with
   specialized UI in detail slots); add workflow extensions where needed.
   Every `many` relation gets a detail table and every FK a derived inverse
   unless you omit it with a reason (`detail.omitRelations`, `inverseOmit`).
5. Run `pnpm generate`; review generated source like handwritten source.
6. Declare physical edge semantics and operation-specific lifecycle policies,
   when the entity participates in deletion or merge. A new shortcode table
   adds `entityIdentityFk(...)` beside its `shortcodeUnique(...)`; the identity
   triggers follow the roster automatically, and the production cutover for
   an existing database must backfill `Entity`. A new join or child table that
   carries an edge column names its owner in `ENTITY_EDGE_OWNERS`.
7. Run generated action contracts and the affected PostgreSQL contracts, plus
   UI and built-browser checks for changed presentation. Follow the repository
   validation guide for final gates.

The compiler owns mechanical catalogs and capabilities. Repositories retain the
handwritten transaction seams until their ports can be generated without
weakening domain invariants.
