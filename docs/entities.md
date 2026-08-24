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
    mcpOut: null,
  },
  filters: { urlKeys: ["name", "createdAt"] },
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
  },
});
```

The exact accepted keys are enforced by the compiler. Source references name a
module and export; they are not executable imports in the spec.

Generated artifacts provide the exhaustive entity keys and traits, public
shortcode contracts, schema bindings, browser route roster, filter URL catalog,
kernel action capabilities, and contract cases. Shared browser helpers consume
the roster, while TanStack route modules remain thin handwritten entrypoints.
Specialized screens stay as extension slots in shared shells.

The declaration is authoritative only for declared mechanical behavior. A spec
does not replace a repository's transactions, locking, SQL, or workflow rules.

## Runtime boundary

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

tRPC is a replaceable browser adapter. Generic behavior is exposed through only
`entity.query` and `entity.mutate`; legacy entity-shaped procedures are thin
typed compatibility aliases while callers migrate. They contain no business
logic.

MCP invokes `executeEntity` directly through the `entity` tool and publishes its
machine-readable contract at `entities://catalog`. Workflow-shaped MCP tools
remain separate. MCP, jobs, repositories, and kernel tests must not import the
complete tRPC `appRouter`; only the `/api/trpc` entrypoint and browser client
typing may do so.

## Filters and search

A filter declaration currently compiles the canonical URL keys used by shared
route search-parameter assembly and generated contract cases. Controls, Zod
input schemas, option loaders, and SQL predicates remain explicit extensions;
the compiler does not infer database behavior from a URL key.

Searchable entities use persisted `SearchDocument` rows for lexical and
embedding input. The spec generates search capability gates, while projection
SQL and embedding loaders remain explicit because several entities need joins,
aggregates, and workflow-specific text. Search-document repair must be queued
after projection changes; source edits do not rewrite persisted rows.

## Relations, deletion, and merge

Every local relation declares an inverse and an incoming deletion policy:
`restrict`, `cascade`, `setNull`, or `detach`. Omission means `restrict`.
Omission defaults to `restrict`. These semantic-edge declarations feed the
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
