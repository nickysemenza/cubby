# Declarative application framework

Cubby's entity declarations own scalar fields across storage, validation,
mutations, audit policy, and shared browser presentation. Application workflows
make sequencing, branches, commits, effects, and streaming behavior inspectable.
Repositories and specialized controls retain the domain rules that cannot be
expressed as ordinary scalar operations.

See [compiled entities](../entities.md) for declaration syntax, generation,
transport ownership, and adding an entity.

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
  remain separate. The assistant's `entity_read` tool is read-only.
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

## Compatibility

Source generation does not change stored data. Physical changes require their
own preserving migration under [domain rules](../agents/domain-rules.md#production-changes).
Read-only and workflow-only entities retain explicit capability boundaries;
the generated registries own the current catalog rather than a dated count.

## Validation and delivery

[Agent validation](../agents/validation.md) owns check selection and delivery.
Exercise shared compiler/runtime behavior with representative contracts and
retain real database/browser coverage for domain exceptions. Generated
operation rosters and primitive field enumeration do not establish behavior.
