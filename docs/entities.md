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
pnpm entity:generate
pnpm entity:check
```

`entity:check` fails on invalid metadata, duplicate entity keys or routes, invalid
relation policies, unsupported capabilities, and stale, missing, or extraneous
generated files. Typecheck verifies declaration types and referenced exports.

## One declaration, several consumers

Each declaration co-locates schemas and field policy:

```ts
export default defineEntity({
  key: "example",
  names: { singular: "Example", plural: "Examples" },
  route: { basePath: "examples" },
  table: "Example",
  identifiers: { brand: "ExampleId", shortcode: "EXM-", legacy: null },
  presentation: { titleField: "name" },
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
    images: false,
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

The model owns scalar validation and physical column factories as well as
presentation. `model.storage` declares stored columns; `create`, `update`,
`output`, `bulk`, and `audit` select fields for their respective consumers.
The generator emits field schemas and storage factories; canonical schemas
compose those generated fields with explicit relationship and domain validators.
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
`createEntityDisplayColumns` reads `display.list`. Specialized overrides supply
rendering and table metadata, while the declaration still owns membership and
labels. `display.columnId` preserves an existing computed column identity when
it differs from the field key (for example an evidence count); active list
column IDs must be unique. An override must match a declared list field; an
unmatched override fails instead of silently hiding the column. Computed
identities and domain summaries outside the field model remain explicit columns
alongside the compiled collection. Composite cells suppress their supporting
fields in list metadata so IDs, names, and logos are not displayed twice.
Standard name and image columns are declared by `display.standard` on their
fields. The shared table renders them once, preserving its name editing, image,
and tree controls; scalar column compilation skips those fields. There is no
second standard-column roster in the browser registry.

`display.detailOrder` optionally orders detail facts independently of model and
list order; it must be a nonnegative integer. Unspecified facts retain model
order after explicitly ordered facts. Detail overrides may provide a dynamic
label when the value changes its meaning, such as ISBN versus UPC. Static labels
remain declared. `EntityBasicInfo.afterFields` anchors computed facts after a
declared detail field without inventing persisted fields or API contracts.
Unknown detail override keys and computed-fact anchors fail explicitly.
`display.detailSection` assigns a fact to an authored section, defaulting to
`overview`. Pass that section to `EntityBasicInfo` instead of maintaining a local
field subset. Project resource links use this to retain their own card while
the declaration still owns their labels and membership.

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

Generated artifacts provide the exhaustive entity keys and traits, public
shortcode contracts (including inbound-only legacy aliases), schema bindings,
client-safe inspector metadata, browser route roster, filter field/URL catalogs,
kernel and MCP action capabilities, relation-specific command schemas,
repository/relation-adapter assembly, and contract cases.
Shared browser helpers consume the roster, while TanStack route modules remain
thin handwritten entrypoints. Specialized screens stay as extension slots in
shared shells.

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
- post-commit object cleanup and background side effects;
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

The browser operation module chooses one database adapter before invoking a
handler and exposes that adapter through both context handles. Ordinary browser
queries therefore use Hyperdrive's short bounded-stale binding unless their
operation is in the server-owned strong-read registry. Non-browser requests,
fresh-after-write requests, mutations, and workflow streams remain
authoritative. Generic detail, list, and filter reads follow the same policy;
the MCP entity/search allowlist remains a separate transport decision.

Workflow operations are explicit Start functions with no entity business logic in
the transport adapter. Removing an operation has no deployment shim: a tab loaded
before that deployment must reload before calling the removed function.

MCP invokes `executeEntity` directly through the `entity` tool and publishes its
machine-readable contract at `entities://catalog`. The `get_entities` capability
uses the same generated get/list/search contracts with mutation actions excluded
by its input schema. The in-app assistant receives this read-only capability;
the combined mutation tool remains excluded. Workflow-shaped MCP tools
remain separate. MCP, jobs, repositories, entity modules, and kernel tests must
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
key.

Searchable entities use persisted `SearchDocument` rows for lexical and
embedding input. The spec generates search capability gates, while projection
SQL and embedding loaders remain explicit because several entities need joins,
aggregates, and workflow-specific text. Search-document repair must be queued
after projection changes; source edits do not rewrite persisted rows.

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
count for every affected-edge disposition. There is no generic delete preview
or restore.

Merge is keeper-wins. Declared edges are repointed, only explicitly mergeable
fields combine, and uniqueness or workflow collisions reject the operation.
There is no generic merge preview. Entity-specific merge code remains only for
irreducible transaction and collision rules.

## Adding an entity

1. Add one typed `.entity.ts` declaration with field validation, storage, mutation
   policies, presentation, capabilities, and logical relationships.
2. Add its branded id and compose its table and canonical input/output schemas
   from the generated factories. Keep indexes, constraints, domain refinements,
   and relationship projections explicit. A physical change still requires a
   compatible migration; generation does not apply production DDL.
3. Add a kernel repository adapter for the capabilities the spec declares.
4. Add thin TanStack route modules and workflow extensions where needed.
5. Run `pnpm entity:generate`; review generated source like handwritten source.
6. Declare physical edge semantics and operation-specific lifecycle policies,
   when the entity participates in deletion or merge.
7. Run generated action contracts and the affected PostgreSQL contracts, plus
   UI and built-browser checks for changed presentation. Follow the repository
   validation guide for final gates.

The compiler owns mechanical catalogs and capabilities. Repositories retain the
handwritten transaction seams until their ports can be generated without
weakening domain invariants.
