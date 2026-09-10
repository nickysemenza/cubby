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

- Literal specs declare field validation, stored columns, create/update/output
  policies, bulk and audit rosters, references, filters, and presentation.
- Generated factories build scalar schemas and physical columns. Canonical
  schemas compose those factories with relationship projections and domain
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
- Activities and Records navigation use the application-view catalog. Authored
  routes retain their loaders, domain sections, and utility destinations.

## Workflow ownership

A bound workflow exposes the same executable definition used by the inspector.
Argument adapters supply context and input; application decisions belong to named
steps. A single repository transaction, provider operation, or pure computation
can remain one leaf.

The runtime distinguishes reads, commits, and required effects. Required effects
follow their commit, including when cancellation arrives after the write. Ordinary
recovery refuses new or ambiguously acknowledged writes. Durable background jobs
have an explicit exception: their row-owned retry contract settles payload,
completion, and continuation failures, including the original cause of a required
dispatch failure. Cancellation still propagates; recovery failures are not retried
recursively by the executor.

Mapped and bulk workflows preserve input order and bounded concurrency. Started
work settles before failure, cancellation, or early close is finalized; later
windows are not prefetched. Finalization receives every completed item even when
its progress tick was not consumed. Empty operations preserve their original
completion metadata without inventing an item.

Resource streams acquire and release read-only tools and forward cancellation.
Import settlement retains committed recipe receipts for final costing and indexing.
Background payload graphs expose revision checks, replacement dispatch, provider
calls, and persistence; queue draining caches each batch-kind lookup once.
Notion preview, cookbook comparison, semantic similarity, recommendations, and
placement declare their read and decision sequences while retaining domain
computation and provider ports.

## Compatibility inventory

[`baseline.json`](./baseline.json) captures commit
`a65b1f68f982876a98de33470df1ea9f31f40aaf`: 19 entities, 249 operation IDs,
32 workflow modules, and 111 route modules. All baseline operation IDs and kinds
are retained, as are the baseline routes.

[`workflow-status.json`](./workflow-status.json) accounts for the 244 exported
workflow symbols separately: 235 registered application exports, two supporting
helpers, and seven infrastructure exports. Counts establish coverage, not
behavioral parity. Contracts and browser validation provide that evidence.

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

Hosted verification is manual. A local passing run does not imply hosted CI ran,
and registration or an earlier working-tree result is not final-commit validation.
