# Declarative application framework

Cubby's 19 entity declarations own scalar fields across storage, validation,
mutations, audit policy, and shared browser presentation. Application workflows
make sequencing, branches, commits, effects, and streaming behavior inspectable.
Repositories and specialized controls retain the domain rules that cannot be
expressed as ordinary scalar operations.

See [compiled entities](../entities.md) for declaration syntax, generation,
transport ownership, and adding an entity. The [ownership reconciliation](./ownership.md)
identifies the migrated surfaces and their remaining domain ports.

## Entity ownership

- Typed declarations co-locate real Zod schemas and declare field validation, stored columns, create/update/output
  policies, bulk and audit rosters, references, filters, and presentation.
  Shared field, control, and storage vocabularies also constrain the compiler;
  there is one supported authored declaration shape.
- Generated schema maps reference declared Zod objects; column factories retain
  the physical storage policy. Canonical schemas compose those maps with relationship projections and domain
  refinements. Changing source ownership does not apply a database migration.
- Partial updates preserve omitted fields. Scalar patching rejects undeclared
  keys, skips unchanged rows, and audits changes in the same transaction.
  Convenience bulk setters retain their existing all-selected-row responses.
- Alias deduplication, tree invariants, relationship writes, import settlement,
  quantity reconciliation, explicit receiving, and deletion/merge transactions
  stay on registered domain owners. Inventory never auto-decrements.
- Form sections, list membership, standard name/image cells, and detail
  membership/order/sections come from declarations. Specialized renderers retain
  inline edits, quantity displays, relationship filters, and computed facts.
  Unknown renderer overrides fail explicitly rather than silently losing fields.
- Generic MCP inputs reuse canonical mutation schemas. MCP response contracts
  explicitly choose audience-specific projections; specialized tool digests
  remain separate. The assistant's `get_entities` capability is read-only.
- Semantic editing intents select fields once; shared field construction uses
  those selections. Context-sensitive defaults, access rules, command transforms,
  and editor-specific blank handling remain explicit. Canonical schemas validate
  the resulting mutation payloads.
- The existing entity-list module owns query plans and declared columns. List
  consumers retain typed plan bindings and specialized filters/renderers; standard
  eager loaders share one binder while route option objects and page components
  remain independently splittable. Scalar display and column helpers share one
  formatter while retaining their surface-specific empty states.
- Domain wayfinding owns labels and entity membership; the application-view
  catalog derives ordinary destinations and directory projections from it and
  the entity registry. Authored specialty destinations retain their order.

## Workflow ownership

The fluent builder is the public graph-authoring interface. A bound workflow
exposes the same executable definition used by the inspector.
Argument adapters supply context and input; application decisions belong to named
steps. A single repository transaction, provider operation, or pure computation
uses an ordinary registered function when it needs no graph sequencing.
These functions execute directly with tracing and expose their operation identity
to inspection; they do not allocate a one-step workflow graph.
Repositories exclusively own transactions; the workflow runtime has no transaction
adapters, transaction nodes, or after-commit queues.

The runtime distinguishes reads, commits, and required effects. Workflow-level
failure translation preserves cancellation and effect-failure evidence. Required effects
follow their commit, including when cancellation arrives after the write. Ordinary
recovery refuses new or ambiguously acknowledged writes. Queue messages are wakeups,
not durable jobs; handlers gate on the row's own staleness marker (see README
"Background tasks"). Cancellation still propagates; recovery failures are not retried
recursively by the executor.

Mapped and bulk workflows preserve input order and bounded concurrency. Started
work settles before failure, cancellation, or early close is finalized; later
windows are not prefetched. Finalization receives every completed item even when
its progress tick was not consumed. Empty operations preserve their original
completion metadata without inventing an item.

The agent stream is a direct async generator: it acquires and unconditionally
releases read-only tools, preserves event order, and forwards cancellation.
Cookbook-specific preparation feeds the shared bounded bulk executor; there is
no generic preparation framework.
Import settlement retains committed recipe receipts for final costing and indexing.
Background payload graphs expose revision checks, replacement dispatch, provider
calls, and persistence; queue draining caches each batch-kind lookup once.
Notion preview, cookbook comparison, semantic similarity, recommendations, and
placement declare their read and decision sequences while retaining domain
computation and provider ports.

## Compatibility

The migration preserves the 19 entities, 249 operation IDs and kinds, and 111
routes present at `a65b1f68f982876a98de33470df1ea9f31f40aaf`. Git retains the
baseline; generated registries and their exhaustive contract checks own the
current catalog. Separate migration inventories would duplicate that information
without validating behavior.

Cookbook and USDA food retain their existing workflow-only/read-only contracts.
The physical schema snapshot guards column compatibility. Any future physical
schema change needs a compatible migration independently of source generation.

## Validation and delivery

Follow [agent validation](../agents/validation.md). Run focused behavioral tests
while editing, then the full relevant gates:

1. Regenerate artifacts and run `pnpm check:all` for types, lint, formatting,
   entity freshness, bindings, OpenAPI, schema/identifier guards, and tooling.
2. Run unit/UI and PostgreSQL contracts. Tests cover partial updates, auditing,
   failure settlement, streaming finalization, declaration-backed presentation,
   and domain invariants.
3. Build with `pnpm --filter @cubby/web run build:cf` before browser tests.
   Validate desktop/mobile presentation, editing, pantry persistence, copy/print
   behavior, and navigation through the built Worker.
4. Commit with mandatory hooks and run `pnpm verify:local:full` on the exact clean
   final commit before merge. Record that commit and its results in the PR.

GitHub Actions is required on the exact final PR head. A local passing run does
not imply hosted CI passed, and an earlier working-tree result is not
final-commit validation.

Test shared compilers and runtime behavior with representative contracts, then
retain domain-specific exceptions and real database/browser integration coverage.
Do not repeat generated operation-name rosters or primitive form-field enumeration
in each entity's test file. Generated files are marked in `.gitattributes` for
GitHub review; handwritten declarations remain visible, and freshness/type checks
still validate generated outputs.
