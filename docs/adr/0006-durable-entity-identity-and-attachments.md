# ADR 0006: Durable entity identity and one attachment table

Status: Accepted. Superseded in part by ADR 0007 (generic `EntityLink` table; `RunMutation` and `ImageSighting` amendments below).

## Context

Every shortcode-bearing table carried its own identity and lifecycle, and a
merge removed the losing code: old URLs, notes, audit rows, and MCP output
resolved to nothing, and a second merge through an absorbed code could resolve
into a self-merge. Cross-entity rows (`AuditLog`, `SearchDocument`,
`EntityEmbedding`, data exceptions) named their subject with an unenforced
`(entityType, entityId)` pair. File ownership was eight near-identical
`<Entity>Image` joins plus `Cookbook.coverImageId` and `Vendor.logoImageId`,
each with its own read, reorder, merge, and delete code. Data exceptions lived
in `dataExceptions` jsonb columns on Product and Purchase only.

## Decision

`Entity(id, kind, shortcode, createdAt, deletedAt, mergedIntoId)` holds one
durable row per shortcode entity. Payload tables keep their `shortcode` and
`deletedAt` and bind to their identity with a composite `(id, shortcode)` FK,
so a payload cannot disagree with its canonical code or change it. Database
triggers on every payload table write the identity on insert and mirror soft
and hard deletes, so no writer can skip identity; `drizzle-kit push` does not
manage triggers, so every place that builds a database from `schema.ts`
installs them afterwards. `finalizeMerge` records one-hop, path-compressed
`mergedIntoId` redirects. Rows are never deleted, and a code is never reused.

Reads follow a merge redirect to the survivor and report `redirectedFrom`;
detail reads list `previousShortcodes`. Writes never follow a redirect: they
refuse with the survivor's code. A deleted identity reads as a tombstone
refusal that names the deletion.

`EntityAttachment(entityId, entityKind, imageId, role, sortOrder, purpose,
documentKind, idempotencyKey)` replaces every per-entity join and the cover and
logo columns; `(entityId, entityKind)` is a composite FK to `Entity(id, kind)`,
and CHECKs keep `purpose` Product-only and `documentKind` Purchase-only. `role`
follows the subject's declared image storage (`attachment` for galleries,
`cover`, `logo`); detach soft-deletes; upload idempotency is scoped to the
active association. `DataException(entityId, entityKind, check,
...)` replaces the jsonb columns for any entity whose declaration enables
exceptions. `AuditLog`, `SearchDocument`, `EntityEmbedding`, `DataException`,
`RunFinding` (`entityId`/`entityKind`), `RunMutation` (`targetId`/`targetKind`),
`RunTarget` (`entityId`/`entityKind`, kinds purchase, product and image),
`SuggestionDismissal`, `AiUsage`, and `AiAnalysis` (`entityId`/`entityKind`)
reference `Entity(id, kind)` with a composite FK; history keeps the identity
that received each event and exposes the survivor only as a read-time
`canonicalEntityId`. `AiUsage` and `AiAnalysis` both allow a null `entityId`
(a call or analysis with no owning entity — `AiAnalysis`'s `entityKind =
'global'` always pairs with a null id, enforced by its own check), which the
composite FK's MATCH SIMPLE semantics pass without requiring a match.
`RunFinding` and `RunMutation` keep the mutation-provenance behavior this ADR
established for cross-entity rows: findings are live pointers a merge repoints
and a removal deletes, while mutations and AI usage/analysis are history that
keeps its original identity, with no cleanup on merge or removal.

The physical graph is read, not stored: `ENTITY_EDGE_OWNERS` names the owning
entity of each non-entity row that carries an edge column, and one runtime
`UNION ALL` over the edge registry yields `(edgeKey, sourceKind, sourceId,
targetKind, targetId)` with both ends live. Connections, delete/merge impact
previews, the graph explorer's physical edges, and the orphan finder read it.

## Rejected alternatives

- A generic `EntityRelation` table holding every local edge. It would reverse
  ADR 0001, force checked endpoint projections back onto payloads for local
  unique indexes, and turn every typed join into a join through one table.
  The runtime edge source gives the graph read without it.
- EAV attributes, a graph database, a universal entity memo, and renaming
  `Image` to `StoredFile` add indirection without changing the typed domain
  relationships or the existing stored-file contract.

## Consequences

Identity is structurally enforced: an insert without an identity, a code
rename, a cross-kind history row, and a hard delete that skips its tombstone
all fail in the database. Entity ids must be unique across entity tables,
which random UUIDs already guarantee; fixtures cannot reuse a fixed id in two
tables. Composite FKs into `Entity(id, kind)` show as drift to an interactive
`db:push` (it offers to drop and re-add them); cancel those statements.

ADR 0001 still holds: physical edges remain typed FKs and joins, lifecycle
remains per-operation policy, and there is no generic edge table.
`EntityAttachment.entityId` and `RunTarget.entityId` are the edge keys that
target several entities; the relatedness traversal resolves its outgoing direction from the
path's destination.

## Amendment (ADR 0007 and the 2026-09 consolidation)

- The "no generic edge table" rejection above no longer holds for the seven
  same-shaped pairings; see ADR 0007. `EntityAttachment` and the other
  payload-carrying edges stay typed tables.
- `(entityType, entityId)` on `AuditLog`, `SearchDocument`, and
  `EntityEmbedding` is `(entityKind, entityId)`, like every other pointer
  named here. `RunMutation` no longer exists: its rows are `AuditLog` rows
  keyed by `runId`.
- Schema, including the identity triggers, reaches every database through the
  committed migrations in `apps/web/drizzle/`; `db:push` no longer exists.
- Deliberate exception to "Entity rows are never deleted": `ImageSighting` is
  a plain child table of Image, not an entity. Its audit rows were moved onto
  the parent Image (`entityKind = 'image'`, nested under
  `changes.sightings[<sighting id>]`) and then its `Entity` rows were deleted;
  the `IMS-` prefix left the shortcode registry. ADR 0005's amendment records
  the same change from the sighting side.
