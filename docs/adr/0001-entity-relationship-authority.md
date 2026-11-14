# ADR 0001: Entity relationship authority

Status: Accepted. Superseded in part by ADR 0007 (generic `EntityLink` table).

## Context

Cubby has typed domain tables and repository-owned transactions, but logical
relationship metadata, generic relation command schemas, runtime dispatch,
MCP exposure, lifecycle descriptions, and documentation had drifted across
separate handwritten rosters. Logical deletion labels also could not represent
the fact that delete and merge treat the same physical edge differently.

## Decision

Restricted entity literals are the authority for logical relationships. Each
relationship declares target, cardinality, named provenance sources, inverse
paths, and any typed mutation adapter plus browser/MCP exposure. The compiler
emits neutral schema/type bindings, server-only executable bindings, and
client-safe inspector/graph metadata. `executeEntity(context, command)` remains
the public kernel entry point, while repositories retain transaction ownership
and domain invariants.

Physical edges remain typed foreign keys or join tables. Each `defineEdge` declaration owns its stable domain
semantics and separate delete/merge policies, including the named functions that execute
specialized behavior. Compositions name their physical sources and inherit their policies.
The generator emits the physical catalog and lifecycle bindings; repositories own execution.

## Consequences

Generated validation rejects unsupported relation and MCP commands before
dispatch, and the inspector and documentation can share canonical logical graph
data. Relationships with multiple evidence paths, such as Purchase products,
remain one logical relation with explicit provenance. Adding a mutable relation
requires a literal declaration and typed adapter; adding lifecycle behavior
requires a policy on its edge declaration, naming the function that the operation executes.

Repository code remains necessary for locking, atomic replacement, audit
ordering, specialized workflows, and other invariants that cannot be inferred
from graph metadata.

## Amendment (ADR 0006)

Entity identity, file attachments, and data exceptions now share generic
tables (`Entity`, `EntityAttachment`, `DataException`); see ADR 0006. That
does not change this decision: domain edges stay typed FKs and joins, and the
physical graph is a read-only projection composed from the edge registry, not
a stored edge table.

## Amendment (ADR 0007)

Pure pairings of two entities — purchase payment accounts, purchase products, project
tools, garden entry plantings, kit components, task and project dependencies —
now share one generic `EntityLink` table whose kinds are declared in
`packages/schemas/src/entity-definitions/link-edges.ts`. That reverses this ADR's "no generic
edge table" for those seven pairings only. Everything else here holds: other
edges stay typed foreign keys, lifecycle policies are declared separately per operation on the edge, and each
link end declares its merge collision rule.
