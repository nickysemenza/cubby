# Durable entity identity and shared file attachments

Status: **implemented**: PR 1 shipped identity, attachments, and the graph
reads; PR 2 drops the legacy storage. The
decision record is [ADR 0006](../adr/0006-durable-entity-identity-and-attachments.md)
and the rollout is [the runbook](../runbooks/entity-identity-schema.md). This
revision replaces the earlier proposal that also moved every local-entity edge
into a physical `EntityRelation` table; see
[Rejected alternatives](#rejected-alternatives).

ADR 0001 stays authoritative: physical edges remain typed FKs and join tables,
and Cubby has no generic edge table.

## Where the implementation differs from this plan

- **Identity writes are database triggers**, not only the
  `insertWithShortcode` seam: every payload table has insert, soft-delete, and
  delete triggers that maintain `Entity`, so no write path can bypass it. The
  payload's own `deletedAt` stays the column its partial indexes use; the
  trigger mirrors it. No static insert/delete check was needed.
- **The edge graph is composed at read time** from `ENTITY_EDGES` and
  `ENTITY_EDGE_OWNERS`, not stored as a database view: same shape, no
  migration, no drift.
- **Attachment roles** are the existing read vocabulary (`attachment`,
  `cover`, `logo`). Deleting a cookbook or vendor now detaches and reaps its
  cover or logo like any gallery photo.
- **A deleted code** refuses with its deletion date instead of returning a
  tombstone body; a merged-away code whose survivor was later deleted refuses
  the same way.
- **Orphan-checked kinds** are a list beside the edge source
  (`ORPHAN_CHECK_KINDS`), not a manifest flag.
- **Data exceptions** keep the per-entity `exceptions` declaration flag; the
  hardcoded Product/Purchase enum is derived from it, and Vendor now opts in.
- **Production data** had one known inconsistency the cutover repairs:
  early-2026 audit entries that filed Product ids under `inventory`.

## Outcome

1. Every shortcode-bearing local entity has one durable `Entity` row. Merges
   leave the loser's code as a permanent read redirect instead of a 404.
2. The eight per-entity gallery joins, `Cookbook.coverImageId`, and
   `Vendor.logoImageId` collapse into one `EntityAttachment` table whose
   subject is a real FK to `Entity`.
3. A generated, read-only `EntityEdge` view exposes every declared physical
   edge as `(kind, source, target)` for traversal, inspector, and integrity
   reads. Writes stay typed.
4. The first polymorphic consumers get real `Entity` FKs: `AuditLog`,
   `SearchDocument`, `EntityEmbedding`, and a new generalized `DataException`.
5. Four read features use the view: a Connections section on every detail
   page, a delete/merge impact preview, the `/graph` explorer's physical
   edges, and an orphan finder in Problems. MCP gets the same connections
   read.

## Why

- A merge removes the losing shortcode, so old URLs, notes, audit rows, and MCP
  output resolve to nothing (`finalizeMerge` records no forward). A second
  merge through an absorbed code can resolve into a self-merge.
- Cross-entity rows use about 40 unenforced `(entityType, entityId)` pairs with
  no referential anchor and bespoke cascade/merge cleanup each.
- File ownership is eight near-identical join tables plus two singular FKs,
  each with its own read, reorder, merge, and delete code.
- Generic traversal and integrity reads rediscover endpoints per table even
  though `ENTITY_EDGES` (`apps/web/src/server/db/entity-edges.ts`) already
  declares every physical edge.

## Rejected alternatives

Recorded so the same ground is not re-litigated.

- **Physical `EntityRelation` for every local edge.** Contradicts ADR 0001,
  forces checked endpoint and lifecycle projections back onto payloads so
  PostgreSQL can enforce local unique indexes, turns every typed join into a
  join through one generic table, and would rewrite every relation-touching
  repository. The graph-shaped read benefit is delivered by the generated
  `EntityEdge` view instead.
- **EAV attributes.** Money (`SUM(Expense.cost)`), business-key uniqueness,
  FK lifecycle, and every generated contract (Drizzle, OpenAPI, MCP, Swift,
  WASM) depend on typed columns. Sparse category-specific attributes use the
  existing `ProductCategory.feature` binding with a typed extension table, or
  a Zod-validated JSONB column for display-only long-tail fields.
- **A graph database.** The graph schema is fixed and declared in the
  manifest; most real queries are aggregations; traversals are 1–3 hops or
  handled by recursive CTEs; and the invariants are relational constraints.
- **`EntityMemo`.** No motivating problem, and it creates a second
  indistinguishable notes field on entities that already have `notes`.
- **`Image` → `StoredFile` rename.** Cosmetic, and it needs a coordinated
  schema/OpenAPI/MCP/Apple regeneration with transport aliases. `Image`
  already stores PDFs; the name stays.

## Scope

### Entity roster

One `Entity` row per kind in the generated shortcode roster
(`shortcodeEntities` in `@cubby/schemas/entity-manifest`), including `Image`.
The roster is authoritative; do not hand-copy a list. USDA Food, relation and
join rows, import workflow records without a shortcode, and other sub-records
are not entities.

### Folded-in backlog items

These were separate `docs/todos.md` entries and ship in this PR:

- **Merge redirects**: the core of this plan. The assertion that a merged
  loser resolves to null (`purchase.integration.test.ts`) becomes a named
  redirect and mutation-refusal regression.
- **Generalized data exceptions**: replace the `dataExceptions` jsonb on
  Product and Purchase and the hardcoded
  `dataExceptionEntity = z.enum(["purchase", "product"])`
  (`packages/schemas/src/data-quality.ts`) with a `DataException` table keyed
  by an `Entity` FK, so any entity with `capabilities.dataQuality` checks can
  record a reasoned exception.
- **Photo-group proposal category and owner as FKs**:
  `PhotoGroupProposal.productCreate` stores category and owner as shortcodes
  in JSON, so a merge or delete between proposing and approving breaks the
  approval. Move them to typed FK columns repointed by merge, like the
  existing `productId` and `inventoryLocationId`. Ids inside JSON would still
  name a redirected loser that mutation resolution refuses.
- **Clean up photo-group proposals whose photos went away**: deleting a run
  image hard-deletes its `ImportRunTarget` but leaves the id in
  `PhotoGroupProposal.images`/`skip`. Strip it in the same file-delete path
  this plan rewrites, and let "Remove group" work on a run that is no longer
  `running` (`apps/web/src/server/photo-import-run/proposals.ts`).
- **Keep agent match evidence through a product merge**: repoint
  `ProductMatchCandidate` rows onto the survivor (re-canonicalizing pair order
  and dropping self-pairs) instead of deleting them
  (`repo/product-match-candidate.ts`, `repo/product/merge.ts`). Lands in the
  merge tail this plan already changes.

### Not included, now unblocked

- Cookbook identity merge (redirects make it cheap; duplicate detection is its
  own domain work).
- MCP staged-file storage (explicitly gated on this plan's file model).
- StatementRow as a manifest entity (needs its `supersededByRowId`
  disposition decision first).
- Converting the remaining polymorphic pairs: one table at a time, classified
  by the reference policy below, never merely because its columns look
  polymorphic.

## Target schema

### `Entity`

```text
Entity
  id            uuid primary key
  kind          text not null
  shortcode     text null
  createdAt     timestamptz not null
  deletedAt     timestamptz null
  mergedIntoId  uuid null references Entity(id)

  unique (id, kind)
  unique (id, kind, shortcode)
  unique (shortcode) where shortcode is not null
  check (kind in <generated roster>)
  check (shortcode is null or shortcode has the prefix declared for kind)
  check (mergedIntoId is null or mergedIntoId <> id)
  check (mergedIntoId is null or deletedAt is not null)
  check (deletedAt is not null or shortcode is not null)
```

- `shortcode` stores the complete canonical code. Never impose uniqueness on
  the four-character body: prefixes are the namespace and cross-kind body
  collisions exist.
- Nullable `shortcode` exists only for legacy tombstones created by the
  backfill for audit/telemetry rows that name a deleted UUID whose code is no
  longer recoverable. Never fabricate a code from a UUID.
- No name, payload, metadata, or `updatedAt`. Rows are never physically
  deleted.

### Payload tables keep their columns, bound to `Entity`

Each shortcode table keeps its `shortcode` and `deletedAt` columns, which every
existing read, partial unique index, and generated contract already uses. The
generator adds:

```text
<Payload>
  entityKind  text not null default '<kind>'   -- storage-only, never public
  check (entityKind = '<kind>')
  foreign key (id, entityKind, shortcode) references Entity(id, kind, shortcode)
```

The composite FK makes a payload structurally unable to point at another
kind's identity or disagree with its canonical shortcode, with no read
rewrites. Shortcodes are immutable, so the FK never needs `ON UPDATE`.

`Entity.deletedAt` is authoritative for public lifecycle. The payload
`deletedAt` stays as the local projection its partial unique indexes need. The
shared delete/merge lifecycle tail is the only writer of both and sets them to
the same timestamp in one statement group; a static check rejects direct
writes elsewhere, and a generated integrity detector reports:

- live Entity without a payload, or payload without an Entity;
- `Entity.deletedAt` and payload `deletedAt` disagreeing; and
- redirect cycles or multi-hop chains.

Every hard delete of a roster row must pass through the lifecycle tail so the
`Entity` tombstone is written; otherwise the resolver reports `live` for a row
that no longer exists. Current hard-delete sites:

- `finalizeMerge` with `removal: "hard"` (`repo/merge/core.ts`, used by
  `mergeIngredients`);
- the image reaper's `tx.delete(image)` (`repo/image.ts`); and
- `ImageSighting` deletes in `repo/image.ts` and `repo/device.ts`.

A static check rejects `.delete(<roster table>)` outside the tail.

### `EntityAttachment`

```text
EntityAttachment
  id               uuid primary key
  subjectEntityId  uuid not null references Entity(id)
  imageId          uuid not null references Image(id)
  role             text not null   -- gallery | cover | logo | attachment
  purpose          text null       -- item | label (Product gallery only)
  documentKind     text null       -- required on Purchase subjects
  sortOrder        integer not null default 0
  idempotencyKey   text null
  createdAt, updatedAt, deletedAt

  unique (subjectEntityId, imageId) where deletedAt is null
  unique (subjectEntityId, role) where role in ('cover','logo') and deletedAt is null
  unique (subjectEntityId, idempotencyKey)
    where idempotencyKey is not null and deletedAt is null
  index (subjectEntityId, sortOrder) where deletedAt is null
  index (imageId)
```

- Replaces `ProductImage`, `LocationImage`, `GardenEntryImage`, `RecipeImage`,
  `MealImage`, `TaskImage`, `PurchaseImage`, `ProjectImage`,
  `Cookbook.coverImageId`, and `Vendor.logoImageId`.
- Carries every join-specific column: `ProductImage.purpose` (null remains the
  displayable legacy item role) and `PurchaseImage.documentKind`. Validation
  rejects `purpose` outside Product subjects and a null `documentKind` on a
  Purchase subject.
- The entity manifest declares which roles each subject kind accepts; attach,
  detach, reorder, and role-change adapters re-check the roster inside the
  write transaction. `Image` subjects accept no attachments.
- Upload idempotency moves from `Image(targetType, targetId, idempotencyKey)`
  onto the attachment: a repeated key reuses the file only while that exact
  attachment is active; detach frees the key. Backfill a key only where the
  old target matches a live association.
- `Image.targetType`/`targetId` upload provenance is dropped in PR 2.
  Soft-deleted attachment rows record which subjects a file belonged to; an
  upload that was never attached loses its target, which only the retry guard
  used.
- The public image inputs (`pendingImageIds`, `removeImageIds`, `imageOrder`,
  `coverImageId`, `logoImageId`) and existing image outputs keep their names
  and meaning for web and MCP; they map onto attachment roles server-side.
  The generic detail contract additionally exposes one ordered `attachments`
  list. `displayImages` stays a server-resolved projection; clients never
  select covers or traverse attachments.
- Detach soft-deletes the attachment for every subject kind, replacing
  today's split (Product soft-deletes its join row; the other joins
  hard-delete). The backfill migrates live join rows only.
- Deleting a subject soft-deletes its active attachments in the same
  transaction, before file liveness is evaluated.

#### Attachment merge rules

In the merge transaction, after locking survivor, losers, and their active
attachments:

1. Build the complete desired survivor set in memory; resolve duplicate-file
   and singular-role collisions before changing any subject FK.
2. Soft-delete loser duplicates while they still belong to the loser, then
   update retained loser roles, then repoint.
3. The survivor's `cover`/`logo` wins. A losing singular file becomes
   `gallery` when the kind supports it and the file is displayable, otherwise
   `attachment`. It is never dropped merely because the slot was occupied.
4. Clear `idempotencyKey` on every moved row; survivor keys stay.
5. Purchase duplicates: equal `documentKind` deduplicates; `other` plus a
   specific kind keeps the specific kind; two different specific kinds return
   a structured collision refusal unless the merge input resolves it.
6. Order: survivor rows first, then loser rows by loser and prior order;
   rewrite contiguous `sortOrder`.
7. Evaluate file liveness only after every new reference exists.

### File liveness

The reaper deletes `Image` bytes and rows only when no active reference
exists. The generated liveness registry covers every FK to `Image` that is not
a cascade-owned child of the file itself:

- `EntityAttachment.imageId`;
- `ImportRunTarget` image FK;
- `ImportPreparedOrder.screenshotImageId`;
- `ImportHunt.receiptImageId`;
- `OrderMailAttachment.imageId`; and
- `ImageSighting`'s image FK (ADR 0005).

`ImageDerivative`, `ImageProcessingJob`, `ImageDescriptionCorrection`, and the
other `image-processing-schema.ts` tables are file-owned children, not
liveness sources. A registry-coverage test fails when a new FK to `Image` has
no declared policy.

### `EntityEdge` view

A generated `CREATE VIEW "EntityEdge"` with one `UNION ALL` branch per entry
in `ENTITY_EDGES`, projecting `(edgeKey, sourceKind, sourceId, targetKind,
targetId)` and filtering soft-deleted rows the same way the typed read does.

`ENTITY_EDGES` records only the referencing `column` today, which does not
name the source entity when that column sits on a join or child row. Each
edge entry therefore gains a declared source owner: the owning entity plus
either a same-row owner column or a join path to it. The generator emits the
join for multi-hop owners; the compile-time `WellKeyed` check extends to the
owner column. Edges whose source is not an entity (workflow rows) are
excluded from the view and listed in its generated header.
It is regenerated with the other schema artifacts, never hand-edited, and is
read-only. Adopt it where it removes hand-maintained endpoint discovery
(inspector graph, "what references this entity", integrity detectors); do not
route typed domain reads through it.

### Graph read features

All four are read-only and share one server read, `entityConnections(code,
{ direction, depth: 1 })`, which resolves the code with read resolution,
queries `EntityEdge` in both directions, and returns edges grouped by
`edgeKey` with the edge's manifest label, role, and liveness, a count, and the
first page of linked entities (shortcode, kind, title, cover). Follow
`apps/web/AGENTS.md` and `DESIGN.md`, and use the `impeccable` skill for the
UI work.

1. **Connections on detail pages.** Extend the existing manifest-backed
   Relations tab and overview preview (`relationships/entity-relations.tsx`,
   `entity-relationship-preview.tsx`) with a Connections section: incoming and
   outgoing groups with counts, each expandable to a paged list of links.
   Do not add a second relationships surface beside the tab. Manifest logical
   relationships that are derived rather than physical keep their current
   rendering.
2. **Delete/merge impact preview.** Delete and merge confirmations show each
   incoming edge group with its count and the operation's declared
   disposition from the incoming-edge policy (repoint, clear, cascade,
   refuse). It is advisory: the repository rule that deletes and merges have
   no live preview still holds, the mutation re-checks transactionally, and
   the structured refusal remains the authority. A group whose policy is
   `refuse` is shown as blocking, with its links.
3. **`/graph` physical edges.** The explorer
   (`routes/_authenticated/graph.tsx`, `entity-graph` contract) reads
   physical neighbors from `EntityEdge`, so every declared edge appears,
   including ones no manifest path covers. Derived manifest paths stay
   computed and are layered on top, labeled as derived.
4. **Orphan finder.** A Problems section lists live entities with no live
   incoming or outgoing edge, for kinds whose manifest declaration opts in
   (`orphanCheck: true`). Kinds that are legitimately standalone (for example
   a Task or a Wish) do not opt in. Each row links to the entity and its
   delete action.

MCP gets `get_entity_connections(code, direction?)`, returning the same
grouped one-hop result. Redirected codes resolve to the canonical entity and
report `redirectedFrom`.

### Reference policy for polymorphic consumers

| Class                  | Target        | Delete             | Merge                                                                                     | In this PR                          |
| ---------------------- | ------------- | ------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------- |
| Durable history        | `Entity` FK   | keep original      | keep original; expose `canonicalEntityId` on read                                         | `AuditLog`                          |
| Rebuildable cache      | `Entity` FK   | delete projection  | delete and rebuild                                                                        | `SearchDocument`, `EntityEmbedding` |
| Entity-scoped decision | `Entity` FK   | delete with entity | survivor keeps its own; loser rows are dropped unless the check is absent on the survivor | `DataException`                     |
| Workflow evidence      | typed FK      | workflow-specific  | workflow-specific                                                                         | unchanged                           |
| Everything else        | existing pair | existing policy    | existing policy                                                                           | unchanged                           |

`Entity`-targeted consumers are invisible to the existing per-entity
incoming-edge policies (`entity-incoming-edges.ts`), which key on payload
tables. `cascadeRemoval` and `finalizeMerge` therefore apply this table's
policy to every `Entity` FK (`EntityAttachment`, `DataException`,
`SearchDocument`, `EntityEmbedding`, `AuditLog`) for every kind, and a
registry-coverage test fails when a new FK to `Entity` has no declared class.

Historical rows always keep the identity that received the event; an
`AuditLog` row written against a loser is never repointed. Nullable
references need paired-null checks where a kind column remains, because a
composite FK under `MATCH SIMPLE` skips enforcement when any member is null.
Drop the old `entityType` column only where joining `Entity.kind` preserves
the consumer's index use.

## Resolution and merge

### Resolver

One internal result replaces "row or null":

```text
live        requested identity is live
redirected  requested identity is a merge loser; returns the canonical
            identity (live, or its tombstone if deleted after the merge)
deleted     requested identity is an unmerged tombstone
missing     invalid input or no identity ever owned the code
```

- `resolveEntityRead(code)` follows the redirect and returns the canonical
  entity or a minimal tombstone, with `redirectedFrom` set when it followed
  one. Used by detail routes, MCP `get`, and global-search navigation.
- `resolveEntityMutation(code, expectedKind)` accepts only a live, canonical
  identity of the expected kind. Redirected and deleted codes are structured
  refusals, never rewritten targets. Used by every write, filter, attach,
  detach, delete, and merge input.

Repositories receive branded UUIDs after this ingress step and never parse
shortcodes again. The permanent `P-`/`L-` inbound spellings stay parser
aliases and create no rows.

Generic detail output gains `redirectedFrom: string | null` and
`previousShortcodes: string[]` (the loser codes whose `mergedIntoId` is this
entity), alongside `attachments`.

### Merge invariants

Same-kind only, in one transaction:

1. Resolve survivor and losers with mutation resolution and lock them.
2. Reject deleted, redirected, duplicate, cross-kind, or self targets. Check
   distinctness on resolved UUIDs as well as input codes.
3. Apply the entity's existing merge policy, attachment rules, the
   `ProductMatchCandidate` repoint, and `DataException` policy.
4. Set each loser `deletedAt` and `mergedIntoId` through the lifecycle tail.
5. Path-compress: repoint older redirects that target any new loser.
6. Require the survivor live and unredirected at commit.

A later ordinary delete of the survivor leaves incoming redirects valid; old
loser codes resolve to its tombstone and every mutation refuses.

### Allocation

`insertWithShortcode` becomes the single allocation seam: mint the code,
insert `Entity`, insert the payload with the same UUID and code, and retry the
savepoint on the `Entity` shortcode unique violation, which replaces the
per-candidate SELECT in `generateUniqueShortcode`. Two production paths
currently bypass the helper and must route through it:

- Idempotent file creation (`repo/image.ts`), which needs
  `onConflictDoNothing` on the idempotency key; the seam gains that mode.
- Product import/restore (`repo/product/crud.ts`), which replays an explicit
  shortcode. It is refused when any `Entity` row, live or tombstone, already
  owns the code, so shortcodes are never reused. A static check permits direct payload inserts only in migration and test
  factories; test factories use the same seam so the payload FK holds.

## Rollout

Downtime is acceptable and there is no maintenance mode. Between the migration
and the new deploy, old-code writes fail against the new constraints and
surface as errors; that is accepted. There are no dual writes and no
write-freeze choreography.

Native clients may break until the household installs the build generated from
this PR. The Apple client is regenerated in the same PR with no transport
compatibility aliases.

Execution owner: main agent for implementation, the migration, and final
validation. No delegated lanes.

### PR 1: everything except the drops

Contents: ADR 0006 and the ADR 0001 amendment; schema; generator changes; a
hand-authored migration SQL file with the expand, backfill, and constraint
steps; code switched to the new model; tests; and
`docs/runbooks/entity-identity-schema.md`. Do **not** point `db:push` at this
change, and open the PR **without auto-merge**
(see the auto-merge runbook rule in `docs/todos.md`). The development
`DATABASE_URL` may be production.

Runbook, in order:

1. Take a database backup and an R2 object listing.
2. Pause queue delivery (`wrangler queues pause-delivery` for
   `cubby-background`, `cubby-telemetry`, and `cubby-purchase-agent`). The
   queues have no dead-letter queue and retry three times, so messages that
   ran against the half-migrated schema would otherwise be dropped. Cron runs
   are not stopped; a failed run is picked up by the next one.
3. Run the migration SQL:
   1. Create `Entity`, `EntityAttachment`, `DataException`, and the
      `EntityEdge` view; add nullable `entityKind` and new FK columns.
   2. Backfill `Entity` from every shortcode table with the existing UUID,
      code, kind, `createdAt`, and `deletedAt`. Verify exact per-kind counts
      and zero canonical-code collisions.
   3. Reconstruct merge redirects from unambiguous merge audit evidence;
      write ambiguous cases to a review report instead of guessing.
   4. Create legacy bodiless tombstones for audit/search/embedding rows that
      name an unknown UUID; report every one with its source.
   5. Backfill `EntityAttachment` from the eight joins and the cover/logo
      columns, preserving order, `purpose`, and `documentKind`, and moving
      idempotency keys only onto matching live associations.
   6. Backfill `DataException` from the Product and Purchase jsonb, the new
      `Entity` FKs on `AuditLog`, `SearchDocument`, and `EntityEmbedding`, and
      `PhotoGroupProposal` category/owner ids.
   7. Set `entityKind` defaults and `NOT NULL`, add the composite FKs and
      checks as `NOT VALID`, then `VALIDATE`.
   8. Run every integrity detector and the parity queries in
      [Validation](#validation); abort and restore on any divergence.
4. Merge the PR and let it deploy.
5. Smoke test: read a live code, a merge-loser code (redirect), a deleted code
   (tombstone); attempt a mutation through a loser code (refused); upload,
   reorder, and detach an attachment; run one reaper pass in report-only mode.
6. Resume queue delivery.

The IntegreSQL schema template is rebuilt as part of the PR's own test run,
not as a production step.

Rollback before step 4: restore the backup. After step 4 and before PR 2:
redeploy the previous build; old tables are still intact but lack writes made
since the window, so restore from backup if that gap matters.

### PR 2: drops

After at least one full background and import cycle with clean detectors:
drop the eight gallery joins, `Cookbook.coverImageId`, `Vendor.logoImageId`,
`Image.targetType`/`targetId`/`idempotencyKey` and their unique index, the Product/Purchase
`dataExceptions` columns, and the `entityType` columns the reference-policy
migration made redundant. Remove their generator branches and handwritten
bindings in the same PR.

## Validation

### Database

- Exact per-kind `Entity` and payload counts; zero payloads without an
  identity and zero live identities without a payload.
- Zero `deletedAt` disagreements between `Entity` and payloads.
- Zero duplicate canonical codes, redirect cycles, or multi-hop chains.
- Exact old/new attachment parity by subject, file, role, order, `purpose`,
  and `documentKind`; every Purchase attachment classified.
- `EntityEdge` row counts per edge key equal the typed tables' live counts.
- Zero files reaped while referenced by any liveness source.
- Query plans for code resolution, attachment list, display image, search, and
  reaper queries recorded before and after.

### Behavior (table-driven where the shape repeats per kind)

- A canonical code reads the live entity with no `redirectedFrom`.
- A loser code reads the canonical entity and reports the requested code;
  after the survivor is deleted, both codes return the same tombstone.
- Update, delete, merge, attach, and detach through a loser or deleted code
  are refused.
- Cross-kind payload insert and cross-kind merge fail transactionally.
- Merging `keep=A, loser=B` after B was absorbed into A is refused, not a
  self-merge.
- Path compression leaves one-hop redirects and every old code resolvable.
- Audit rows keep original attribution and expose the canonical identity.
- Survivor singular attachment wins; the loser's is demoted and kept.
- Idempotency key reuse works only on an active association for that subject;
  detach frees it; merge never transfers loser keys.
- Purchase document-kind merge rules hold; primary-document selection results
  are unchanged.
- An image attached to two entities survives either entity's deletion; a
  workflow-only image survives with no attachment.
- A photo-group approval still succeeds after its proposed category or owner
  was merged.
- Merging two Products keeps a third-party agent match candidate.
- A data exception can be recorded on an entity other than Product or
  Purchase.
- Deleting a subject soft-deletes its attachments; a file then referenced by
  nothing is reaped, and a file still attached elsewhere is not.
- Reaping an image and deleting a sighting leave `Entity` tombstones.
- Product restore with a code owned by any `Entity` row is refused.
- `entityConnections` returns the same edges as the typed tables for a
  representative entity of each kind, in both directions, and follows a
  merge redirect.
- The impact preview's groups and dispositions match what the delete or merge
  then does, and a `refuse` group matches the structured refusal.
- The orphan finder lists only opted-in kinds with zero live edges.

### Repository gates

Regenerate schema, route, OpenAPI, MCP, and Swift artifacts rather than hand
editing; run focused resolver, merge, delete, attachment, display-image,
search, audit, import, photo-group, data-quality, and reaper tests; run the
PostgreSQL integration suite; `pnpm typecheck`, `pnpm check`, the affected
fast-test graph, and built-browser tests; validate the Apple client build; and
require GitHub Actions to pass on the exact final head.
