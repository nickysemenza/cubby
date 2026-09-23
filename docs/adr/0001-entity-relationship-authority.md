# ADR 0001: Entity relationship authority

Status: Accepted

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

Physical edges remain typed foreign keys or join tables. Their stable domain
semantics are separate from operation-specific lifecycle policies. Each delete
or merge policy records an executable owner (`kernel` or `workflow`) and a
disposition for every incoming edge. Logical relationships do not carry a
deletion policy, and Cubby does not introduce an EAV or generic edge table.

## Consequences

Generated validation rejects unsupported relation and MCP commands before
dispatch, and the inspector and documentation can share canonical logical graph
data. Relationships with multiple evidence paths, such as Purchase products,
remain one logical relation with explicit provenance. Adding a mutable relation
requires a literal declaration and typed adapter; adding lifecycle behavior
requires a physical-edge policy owned by the operation that executes it.

Repository code remains necessary for locking, atomic replacement, audit
ordering, specialized workflows, and other invariants that cannot be inferred
from graph metadata.

## Amendment (ADR 0006)

Entity identity, file attachments, and data exceptions now share generic
tables (`Entity`, `EntityAttachment`, `DataException`); see ADR 0006. That
does not change this decision: domain edges stay typed FKs and joins, and the
physical graph is a read-only projection composed from the edge registry, not
a stored edge table.
