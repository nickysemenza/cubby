# Compiled entities

Cubby's ordinary entity surfaces are compiled from restricted literal specs in
`scripts/entity-literals/entities/*.entity.ts`. The generator parses them with
Oxc; it never imports or executes them. This makes the spec usable by tooling
without pulling application modules into scripts or depending on TypeScript's
compiler API.

Run:

```bash
pnpm entity:generate
pnpm entity:check
```

`entity:check` fails on invalid syntax, dynamic expressions, duplicate entity
keys or routes, invalid relation policies, unsupported capability keys or
values, and stale, missing, or extraneous generated files. Typecheck verifies
that referenced schema modules and exports exist.

## One declaration, several consumers

Each spec is a call whose argument is literal data:

```ts
export default literalEntity({
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
    mcp: ["get", "list", "create", "update", "delete"],
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
      lifecycle: { policy: null, runtime: null },
      relationMutation: { attach: null, detach: null },
    },
  },
});
```

The exact accepted keys are enforced by the compiler. Source references name a
module and export; they are not executable imports in the spec. `fields.detail`
is optional and falls back to `fields.output`; declare it when the current
detail read carries enriched relations or computed fields.

`extensions.ports` is the explicit seam map for behavior the compiler must
not infer: the kernel repository binding, entity label and shortcode resolver,
filter declaration, search-document projection/text/refresh hooks, lifecycle
policy/runtime binding, and any attach/detach implementation. Each entry is a
`{ module, export }` source reference or `null` when that port is intentionally
absent or remains a workflow-only seam. The generated inspector projects these
references as client-safe data; the server roster is a lookup catalog, not a
dynamic importer. Repository closures still own transactions and service
injection.

Filter descriptors are restricted literal records. Static choices stay literal;
icon-bearing option lists, identifier brands, and compound preset expansion use
explicit `{ module, export }` references. The compiler rejects unsupported
kinds/properties and duplicate columns or derived URL keys. `audit: true`
expands the standard created/updated date filters. SQL predicates remain explicit
in repository filter builders.

Generated artifacts provide the exhaustive entity keys and traits, public
shortcode contracts (including inbound-only legacy aliases), schema bindings,
client-safe inspector metadata, browser route roster, filter field/URL catalogs,
kernel action capabilities, repository-adapter assembly, and contract cases.
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

Generic detail, list, and filter reads use the request-selected read handle.
Ordinary browser requests may therefore use Hyperdrive's bounded-stale cached
binding; non-browser requests and requests carrying the fresh-after-write
marker select the authoritative binding. Mutations remain authoritative.

Workflow operations are explicit Start functions with no entity business logic in
the transport adapter. Removing an operation has no deployment shim: a tab loaded
before that deployment must reload before calling the removed function.

MCP invokes `executeEntity` directly through the `entity` tool and publishes its
machine-readable contract at `entities://catalog`. Workflow-shaped MCP tools
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

Every local relation declares an inverse and an incoming deletion policy:
`restrict`, `cascade`, `setNull`, or `detach`. Omission defaults to `restrict`.
These semantic-edge declarations feed the
catalog; repository edge-role policies remain the runtime authority until the
relation-policy compiler replaces them.

Deletion is one command. Soft versus hard deletion is a capability, and the
result identifies the deleted public references plus exact affected edges when
the repository can report them. There is no generic delete preview or restore.

Merge is keeper-wins. Declared edges are repointed, only explicitly mergeable
fields combine, and uniqueness or workflow collisions reject the operation.
There is no generic merge preview. Entity-specific merge code remains only for
irreducible transaction and collision rules.

## Adding an entity

1. Add its table, migration, branded id, and Zod input/output schemas.
2. Add one literal `.entity.ts` spec with all capabilities and relation policies.
3. Add a kernel repository adapter for the capabilities the spec declares.
4. Add thin TanStack route modules and workflow extensions where needed.
5. Run `pnpm entity:generate`; review generated source like handwritten source.
6. Run generated action contracts, PGlite mechanical contracts, and any
   real-Postgres tests required by repositories, raw SQL, extensions, or
   concurrency.

The compiler owns mechanical catalogs and capabilities. Repositories retain the
handwritten transaction seams until their ports can be generated without
weakening domain invariants.
