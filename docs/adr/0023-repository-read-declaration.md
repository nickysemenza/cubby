# ADR 0023: Repository read declaration

Status: Accepted. Amends [ADR 0006](0006-durable-entity-identity-and-attachments.md)
(reads stop following merge redirects) and builds on
[ADR 0019](0019-domain-first-server-layout.md) (no module-level registries) and
[ADR 0021](0021-derived-values.md) (derived values).

## Context

`listScaffold` compiled filters, sorts, grouping and derived values from the
entity declaration, but each domain still hand-wrote its read. Vendor named
each derived field four times: a column map, the scaffold's derived options,
the list reader's destructure, and a separate select in `getVendorByID`. Every
domain repeated that `xList`/`xListRead`/`getXByID`/`dbXToAPI` set. Each
domain also carried a list summary with hand-written sums, and a
`build*Where` alias for generic callers. Only five domains honoured projection
groups.

Generic modules reached the same facts through per-entity rosters. The
rosters included:

- the dashboard's `COUNT_WHERE`;
- the Problems reader table;
- the `facetCounters` Map, filled by import side effects;
- the generated `ENTITY_LIST_READ_OPERATIONS`.

Each roster restated what the scaffold already knew, and each new entity had
to be threaded through all of them.

## Decision

**The read is a repository port.** Each domain declares one
`xScaffold = listScaffold(entity, table, { derived, read })` and passes it to
`defineRepository(entity, { scaffold, ... })`. Every entity has a scaffold. A
read fact is stated once:

- The **entity declaration** owns read keys and their types, rollups,
  `presentation.list.totals`, and `presentation.list.initialFilter`.
- The **read declaration** (`read` on the scaffold) owns everything else:
  - SQL for each remaining key (`columns`, or `derived` for declared derived
    values);
  - per-page loaders as bindings (`bind`, `bind.batch`, `bind.ids`);
  - references and media;
  - an optional row `load` for relation-loaded rows, and an optional
    filter-dependent `orderBy`.
- **Generated bindings** wire the scaffold into the kernel
  (`ENTITY_KERNEL_BINDINGS[entity].repository.scaffold`). Generic modules take
  the scaffold, or `kernelScaffold(entity)`, as an argument.

**Everything else falls out of the scaffold:**

- **List page:** `scaffold.read`. The default select is the table's columns,
  the projected derived keys, and the declared columns.
- **Record read:** `scaffold.get`/`getByIds`. It is the same select and plan
  by code or id, with no ordering and no window count. Writers read their
  output through `createEntityReader({ entity, scaffold, output })`.
- **Totals:** `scaffold.totals`, computed from the declared totals in one
  aggregate statement. They load only for a full page, or for a projection
  that names a total key.
- **Population:** `scaffold.where(filters)`. Dashboard counts are
  `scaffold.where(declared initialFilter)` in a single statement.

**A projection is a field list.** `ListProjection` is `readonly string[]`, and
admission is per key; projection groups are gone. The scaffold publishes
`fields.list` and `fields.detail`. A binding declared `{ scope: "detail" }`
loads only on record reads. A detail binding may override a page binding of
the same key when the record read needs a richer shape.

**One repository read schema per entity:** the list and detail contracts
merged. A key whose shapes differ accepts either shape.

**The read carries its caller.** `ListContext.reader` holds the actor and the
kernel's clients (the USDA client). Viewer-relative values (an Email's
`ownedByViewer`) and food enrichment then need no per-entity read path.

**Reads no longer follow merge redirects.** A merged-away code is not found,
and its message names the survivor.

## Rejected alternatives

- **Keep per-domain list readers and only share helpers.** This is the shape
  that produced the four-fold restatement, and it leaves every generic roster
  in place.
- **Generate field sets from the declaration.** Which keys are detail-only is
  a property of how a repository loads them (`scope: "detail"`), not of the
  entity model. Publishing `fields` from the scaffold keeps that fact in one
  place.
- **Keep a Job exception.** The Job queue's scaffold options are shared with
  the Job repository's read declaration, so Job reads like every other entity.

## Consequences

- A new entity's read is one scaffold. A key that its schema declares but
  nothing loads fails when the read plan is built.
- Generic modules no longer import domain readers or where-builders.
- Contracts changed in place: the merge-redirect fields are gone, and the
  native client bumps `APPLE_CLIENT_COMPATIBILITY_VERSION`.
