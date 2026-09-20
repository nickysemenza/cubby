# Durable entity identity and shared files

Status: **proposed end state**. This plan supersedes the tabled Entity
supertable design from 2026-09-19, now removed after its verified constraints
were carried forward here. It does not supersede ADR 0001: physical domain
relationships remain typed.

## Outcome

Give every local, shortcode-bearing entity one durable identity row, preserve
old shortcodes as permanent read redirects after a merge, and replace the
repeated image ownership shapes with one shared file-attachment model.

This is not an EAV conversion and not a universal graph table. The end state
has four deliberately different relationship shapes:

| Relationship | Cardinality | Storage |
| --- | --- | --- |
| Durable identity to typed payload | exactly 1:1 while live | `Entity` plus one kind-correct typed table |
| Ordinary domain relationship | whatever the domain says | typed FK or typed join table |
| Entity to stored file | M:N | `EntityAttachment` |
| Historical/cache/telemetry subject to entity | N:1 | FK to `Entity` |
| Merged identity to its survivor | N:1 | `Entity.mergedIntoId` |

The generic seam is identity, resolution, and file attachment. Product,
Inventory, Recipe, Purchase, Expense, allocation, dependency, and other domain
relationships keep their current typed semantics. There is no
`EntityRelation(fromEntityId, toEntityId, kind, metadata)` table.

## Why this is an improvement

The current schema has three recurring problems:

1. Identity and lifecycle are copied into every shortcode table. A merge
   removes the losing public reference, so old URLs, notes, audit records, and
   MCP output cannot resolve to the survivor.
2. Cross-entity consumers use unenforced `(entityType, entityId)` pairs. These
   pairs have different lifecycle meanings but no common referential anchor.
3. File ownership is expressed through eight near-isomorphic gallery tables,
   two singular FKs, and additional workflow evidence FKs. `Image` already
   stores PDFs, so the storage concept is broader than its name.

The proposed model pays for one additional identity layer by deleting repeated
shortcode/lifecycle behavior, making merge redirects durable, giving selected
polymorphic references a real FK, and consolidating the genuinely isomorphic
file-association family. It does not claim that generic storage is inherently
better; the typed entity kernel remains the behavioral seam.

### Carry-forward constraints from the tabled review

The earlier plan found concrete hazards that remain implementation
requirements. Its dated production row counts are intentionally not copied;
Phase 0 remeasures live data before migration.

- Store and uniquely index the complete canonical shortcode. Never impose
  global uniqueness on the four-character body: the 2026-09-19 snapshot found
  623 cross-kind body collisions, and prefixes are the namespace.
- Write the permanent Entity tombstone from the shared lifecycle tail reached
  by every removal path. Ingredient merge and inventory consolidation currently
  hard-delete payload rows and must not bypass identity retention.
- Mutation resolution must not follow redirects. Merge distinctness is checked
  on resolved UUIDs as well as input codes so a previous loser cannot resolve
  back to the keeper and create a self-merge.
- Product restore and idempotent file creation currently bypass the ordinary
  shortcode insert helper, and tests also insert payloads directly. Every
  production path must use the atomic identity/payload allocation seam; a
  static check permits only explicit migration and test factories.
- Keep the reference-policy registry separate from the existing typed
  incoming-edge registry. A cross-entity history/cache policy is not a physical
  per-kind edge policy, and forcing both through one exhaustive roster obscures
  their different lifecycle owners.
- Nullable polymorphic references need paired-null checks. PostgreSQL's default
  composite-FK `MATCH SIMPLE` behavior skips enforcement when either member is
  null; a consumer either requires both identity and kind or declares its
  intentional partial/global state explicitly.
- The migration requires hand-authored `NOT VALID`/`VALIDATE`, checks, and
  read-back verification. `db:push` cannot express or safely infer the whole
  cutover, and the development `DATABASE_URL` may be production.
- Allocation should use the Entity insert's unique violation as the shortcode
  collision probe inside the savepoint instead of adding another advisory
  round trip.
- Rebuild the IntegreSQL schema template after the physical schema changes, in
  addition to regenerating the ordinary checked artifacts.

## Scope

### Included entity identities

Create one `Entity` row for every local kind in the generated
`SHORTCODE_TABLE` roster:

- cookbook, expense, financial account, financial transaction;
- garden entry, ingredient, inventory, ledger party, ledger transfer;
- location, meal, planting, product, project, purchase, recipe, task;
- vendor, vendor account, wish; and
- the stored-file entity that replaces the current `Image` payload.

USDA Food stays outside this identity system because it is an external dataset
without a Cubby shortcode. Join rows, allocations, recipe sections, import
runs, import findings, mail rows, and other workflow/sub-entity records are not
entities merely because they have UUID primary keys.

### Included capabilities

- One authoritative UUID, kind, shortcode, creation time, deletion time, and
  optional merge survivor for every included identity.
- Read-time redirect resolution and canonical responses with
  `redirectedFrom`.
- `previousShortcodes` on canonical reads.
- A minimal tombstone response for deleted, unmerged identities.
- One optional, universal `EntityMemo` per identity.
- One M:N `EntityAttachment` table for galleries, covers, logos, PDFs, and
  other directly attached files.
- A reference-policy registry that distinguishes operational, durable-history,
  rebuildable-cache, telemetry, and workflow-evidence references.
- Structural enforcement that every live identity has exactly one payload of
  the correct kind.

### Explicitly not included

- Generic storage for ordinary domain relationships.
- A generic relationship editor or arbitrary graph mutation.
- Inferring mutation behavior from relationship metadata.
- Turning every `(type, id)` pair into an entity FK without classifying its
  semantics.
- Recursive display-image inheritance.
- Restoring deleted entities.
- User-created shortcode aliases or editable shortcodes.
- Making files the only source of file liveness; workflow evidence remains
  explicit.

## Target schema

Names below describe the end-state contract. Exact generated helper names may
change during implementation, but the invariants may not.

### `Entity`: identity and lifecycle only

```text
Entity
  id              uuid primary key
  kind            text not null
  shortcode       text null
  createdAt       timestamptz not null
  deletedAt       timestamptz null
  mergedIntoId    uuid null references Entity(id)

  unique (id, kind)
  unique (shortcode) where shortcode is not null
  check (mergedIntoId is null or mergedIntoId <> id)
  check (shortcode is null or has the canonical prefix declared for kind)
  check (deletedAt is not null or shortcode is not null)
  check (deletedAt is not null or mergedIntoId is null)
```

`shortcode` stores the complete canonical code, not only its four-character
body. It is non-null for every normally created identity. Nullable storage is a
deliberate legacy-history exception: existing AuditLog and telemetry rows can
name a deleted UUID whose former shortcode is no longer recoverable. Those
rows get bodiless deleted identities rather than fabricated codes or discarded
history. Existing canonical values and the `IMG-` values of stored files are
preserved. The permanent inbound `P-` and `L-` spellings remain parser aliases;
they do not create extra rows.

`Entity` has no domain name, JSON payload, arbitrary metadata, note body, or
generic `updatedAt`. Payload tables continue to own their own direct-update
timestamps. Merge, deletion, memo, and attachment changes are visible from the
rows that own those events instead of manufacturing one ambiguous universal
timestamp.

An identity row is never physically deleted. A merged loser is both deleted
and linked to its canonical survivor identity, which may itself be deleted
later. An ordinary deleted identity has `mergedIntoId = null`.

### Typed payload extensions

Each current entity table becomes a typed payload extension. Authoritative
identity and lifecycle move to `Entity`; domain fields and domain timestamps
remain on the payload. A retained payload may also carry a storage-only
`retiredAt` projection when its own partial unique indexes must distinguish live
from historical values.

```text
Product
  id          uuid primary key
  entityKind  text not null default 'product'
  ...product fields...

  foreign key (id, entityKind) references Entity(id, kind)
  check (entityKind = 'product')
```

The generator emits the constant kind column, composite FK, and check for every
payload. This makes a Product payload structurally unable to point at a Recipe
identity. The column is storage-only and never appears in public schemas.

At transaction commit, every live `Entity` must have exactly one payload in the
table for its kind. Implement this with a generated, deferrable constraint
trigger covering `Entity` and every extension table. It must permit zero
payloads for deleted identities because some deletion policies legitimately
remove payload data. A generated integrity detector independently verifies the
same invariant and reports:

- live identity without a payload;
- live identity with a wrong-kind payload;
- live identity with more than one payload;
- payload without an identity; and
- payload whose constant kind disagrees with `Entity.kind`.

All create paths insert the identity and payload in the same transaction and
savepoint. `insertWithShortcode` becomes the single allocation module: it mints
the code, inserts `Entity`, inserts the typed payload with the same UUID, and
retries the whole savepoint on a shortcode collision. Direct payload inserts
outside approved migration/test helpers fail a static repository check.

### Payload retention after deletion

Deletion of `Entity` is always logical. Deletion of its typed payload is a
separate, declared policy:

- `retain`: keep the payload, marked inaccessible through live repositories,
  when a typed historical or workflow reference deliberately survives;
- `remove`: hard-delete the payload after incoming operational edges are
  handled; the `Entity` tombstone remains; or
- `soft-delete`: temporarily retain the current payload lifecycle where a
  staged migration still needs it. This is a migration state, not the preferred
  final policy.

The reference-policy registry determines whether `retain` is required. Two
known examples must be protected explicitly:

- `Ingredient.recipeId` can retain a deleted Recipe payload for staleness and
  recomputation semantics.
- `ImportSourceClaim.purchaseId` can retain a deleted Purchase payload for
  replay suppression.

Operational FKs continue to target typed payloads. Durable historical
attribution targets `Entity`. No caller may infer payload availability merely
from the existence of an identity tombstone.

Retaining a payload must not retain its claim on a live-only business key.
PostgreSQL partial indexes cannot predicate on a joined `Entity.deletedAt`, so a
retained payload with such an index keeps a storage-only `retiredAt` column.
The delete/merge transaction writes it to the same timestamp as
`Entity.deletedAt`, and the partial unique index changes from
`payload.deletedAt IS NULL` to `payload.retiredAt IS NULL`. `Entity.deletedAt`
remains authoritative for lifecycle and every public read. The generated
policy roster lists which retained payloads need this projection; the deferred
invariant verifies a live Entity never has a retired payload. Recipe names and
Purchase `(vendorId, orderId)` are initial required cases. Payloads with no
surviving typed references or live-only keys are removed rather than given a
projection.

### `EntityMemo`: optional universal summary

```text
EntityMemo
  entityId   uuid primary key references Entity(id)
  body       text not null
  createdAt  timestamptz not null
  updatedAt  timestamptz not null
```

Absence means no memo; empty bodies are deleted rather than stored. This is one
short, current summary attached to an identity, not a Note entity, comment
thread, timeline, or replacement for domain-specific `notes` fields. Existing
domain notes retain their current meaning and search behavior.

The generic detail contract exposes `memo: string | null`. Presentation must
avoid two indistinguishable note editors: when a payload already has a domain
`notes` field, label and place the universal value as “Entity memo” in a
separate metadata area.

### `StoredFile`: bytes and metadata

Rename the physical `Image` payload to `StoredFile`. It remains a local entity
with its existing UUID and `IMG-` shortcode so saved links continue to work.
Its entity kind becomes `storedFile`; `image` remains a temporary compatibility
discriminant at old transport boundaries until every client is regenerated.

`StoredFile` owns object-store identity and file metadata: key, MIME type, byte
length, checksum, upload/render status, dimensions when applicable, perceptual
hash when applicable, and timestamps. Supported content remains the current
image formats plus PDF. Whether a file can render as an image is derived from
verified MIME/decoded metadata; “image” is a presentation capability, not the
storage entity.

### `EntityAttachment`: direct file associations

```text
EntityAttachment
  id               uuid primary key
  subjectEntityId  uuid not null references Entity(id)
  fileId           uuid not null references StoredFile(id)
  role             text not null
  sortOrder         integer not null default 0
  documentKind     text null
  idempotencyKey   text null
  createdAt        timestamptz not null
  updatedAt        timestamptz not null
  deletedAt        timestamptz null

  unique active (subjectEntityId, fileId)
  unique active (subjectEntityId, role) where role in ('cover', 'logo')
  unique active (subjectEntityId, idempotencyKey)
    where idempotencyKey is not null
  check role in ('gallery', 'cover', 'logo', 'attachment')
  check documentKind is null or is a declared Purchase document kind
```

The initial roles are:

- `gallery`: ordered, repeatable visual attachment;
- `cover`: singular primary artwork;
- `logo`: singular vendor/organization mark; and
- `attachment`: repeatable general file, optionally classified by
  `documentKind` such as `receipt`, `invoice`, or `other`.

Every included domain entity accepts the repeatable `attachment` role. Entity
declarations state which additional display roles each subject kind accepts;
the stored-file kind itself accepts no file attachments. The attach, detach,
reorder, and role-change adapters validate that roster and re-check it inside
the write transaction. Unsupported combinations fail explicitly. The logical
relationship catalog describes these typed capabilities; it does not make
every catalog edge mutable.

An active attachment must name a live, non-file subject identity and a live
StoredFile payload. Attach/detach/delete transactions enforce that rule, and a
generated deferrable invariant trigger plus the integrity detector guard direct
SQL. Deleting a subject soft-deletes its direct attachments before file
liveness is evaluated. Deleting stored bytes is reaper-owned and cannot proceed
while any active direct or workflow reference exists.

Upload idempotency belongs to the association, not the stored bytes. Moving the
current `Image.targetType`, `targetId`, and `idempotencyKey` onto
`EntityAttachment` preserves the public contract: repeating a key for the same
subject reuses the file only while that exact attachment remains active. After
detach, the key is free and a retry performs a real upload. The attach
transaction locks the subject, checks `expectedImageCount`, creates or promotes
the `StoredFile`, and inserts the keyed attachment; on an idempotency race it
returns the winning active attachment and reaps the losing unreferenced file.
Backfill a key only when the old target provenance matches a live old
association. Targeted-but-detached legacy files do not reserve keys.

`documentKind` is nullable for subjects where document classification has no
meaning, but it remains required for every Purchase attachment and must be one
of the existing Purchase document kinds. Attach, role change, backfill, and
merge all preserve that rule. For a duplicate file during Purchase merge:

- identical classifications deduplicate directly;
- `other` plus one specific classification keeps the specific value; and
- two different specific classifications require an explicit per-file merge
  resolution or return a structured collision refusal.

There is no implicit ordering between `receipt`, `invoice`, and the other
specific categories. Existing primary-document selection continues to read the
resolved `documentKind` and must pass differential tests before the old join is
removed.

The shared table replaces:

- `ProductImage`, `LocationImage`, `GardenEntryImage`, `RecipeImage`;
- `MealImage`, `TaskImage`, `PurchaseImage`, `ProjectImage`;
- `Cookbook.coverImageId`; and
- `Vendor.logoImageId`.

The generic entity detail contract exposes one ordered `attachments` list.
`displayImages` remains a server-resolved projection over directly attached
displayable files plus the existing declared related-image sources. Clients do
not select covers or recursively traverse attachments themselves.

#### Attachment merge rules

When entities of the same kind merge:

1. Lock the survivor, losers, and their active attachments.
2. Build the complete desired survivor attachment set in memory. Resolve
   duplicate-file and singular-role collisions before changing any subject FK.
3. Soft-delete losing duplicate associations while they still belong to their
   original subjects, then update retained loser roles to their desired
   non-conflicting roles.
4. Repoint only the retained, already conflict-free loser associations. The
   survivor association wins for an identical file and keeps the most specific
   non-conflicting metadata. Clear `idempotencyKey` on every association moved
   from a loser: a request key scoped to the old subject must not unexpectedly
   become reusable against the survivor. Existing survivor keys remain.
5. The survivor's existing `cover` or `logo` wins. A losing singular file is
   retained as `gallery` when that kind supports a gallery and the file is
   displayable; otherwise it becomes a normal `attachment`. It is not deleted
   merely because the singular slot was occupied.
6. Preserve stable relative ordering: existing survivor rows first, then loser
   rows ordered by loser and prior `sortOrder`; rewrite contiguous sort values.
7. Re-run file liveness only after the transaction has established every new
   reference.

### File liveness is broader than attachments

`EntityAttachment` is the authority for direct entity ownership, but not the
only legitimate file reference. Workflow evidence remains typed and explicit.
At minimum, the liveness registry includes:

- `EntityAttachment.fileId`;
- `ImportHunt.receiptImageId`; and
- `OrderMailAttachment.imageId`.

Those workflow columns should be renamed to `storedFileId` when their callers
move, but they do not become attachments unless the workflow actually promotes
the file onto an entity. The reaper checks the exhaustive generated liveness
registry before deleting object bytes or a `StoredFile` payload. Adding a new FK
to `StoredFile` must fail a registry-coverage test until its liveness policy is
declared.

## Identity resolution and shortcodes

### Resolver states

Replace “row or null” with one internal resolution result:

```text
live       -> requested identity and payload are live
redirected -> requested identity is a merge loser; canonical identity is live
              or is a tombstone that was deleted after the merge
deleted    -> requested canonical identity is an unmerged tombstone
missing    -> input is invalid or no identity ever owned the code
```

Expose two deliberately different interfaces:

- `resolveEntityRead(code)` follows merge redirects, returns the canonical
  live entity or its minimal tombstone, and includes `redirectedFrom` when it
  followed one.
- `resolveEntityMutation(code, expectedKind)` accepts only a live, canonical
  identity of the expected kind. Redirected and deleted codes are structured
  refusals, never silently rewritten mutation targets.

Filters, attach/detach, delete, and merge use mutation resolution. Detail
routes, MCP `get`, global search navigation, and explicitly declared lookup
surfaces use read resolution. Internal typed repositories receive branded UUIDs
after this ingress step and do not parse shortcodes again.

### Merge invariants

Merges are same-kind only. In one transaction:

1. Resolve and lock the canonical survivor and every loser without following
   redirects.
2. Reject deleted, already-redirected, duplicate, cross-kind, or self targets.
3. Apply the entity-specific typed edge and field collision policy.
4. Apply the attachment and memo policies. If only one identity has a memo,
   move it to the survivor. If multiple distinct non-empty memos exist, require
   an explicit merge input choosing one, combining them into supplied text, or
   clearing them; do not silently apply keeper-wins to authored text.
5. Set each loser `deletedAt` and `mergedIntoId` to the survivor.
6. Path-compress older redirects that point at any new loser.
7. Require the survivor to remain live and unredirected at commit.

Cycles are prevented by locking plus the live-unredirected survivor rule, a
self-reference check, and a recursive integrity detector. Reads may defensively
cap redirect traversal, but a valid database contains one-hop paths after every
merge. A later ordinary deletion of the survivor does not erase or invalidate
incoming redirects: an old loser code resolves to the survivor's deleted
tombstone and every mutation still refuses. “Survivor must be live” is a merge-
time precondition, not a permanent foreign-key condition.

### Previous shortcodes

`previousShortcodes` is derived from the permanent loser identities whose
`mergedIntoId` is the canonical entity. No separate alias table is needed for
normal merges. A canonical response reached through an old code returns both:

```json
{
  "id": "PRD-ABCD",
  "redirectedFrom": "PRD-WXYZ",
  "previousShortcodes": ["PRD-WXYZ", "PRD-7K9M"]
}
```

Historical reconstruction is best-effort. Backfill codes from surviving typed
rows and merge audit evidence only when kind and ownership are unambiguous.
Never fabricate a shortcode from a UUID. Orphan history can point at a bodiless
`Entity` tombstone with no shortcode only when created by the migration; those
legacy tombstones remain permanently afterward. The final integrity report
lists every such row and its source.

## Reference-policy registry

Do not apply one lifecycle rule to every reference merely because it can target
more than one entity. Introduce an exhaustive, generated registry with these
classes:

| Class | FK target | Delete | Merge | Examples |
| --- | --- | --- | --- | --- |
| Operational domain | typed payload | declared typed edge policy | repoint/reject/fold by workflow | inventory product, expense purchase, recipe ingredient |
| Durable history | `Entity` | retain original identity | retain original plus resolve canonical separately | `AuditLog` |
| Rebuildable cache | `Entity` | delete projection | delete/rebuild or repoint then rebuild | `SearchDocument`, `EntityEmbedding`, `AiAnalysis` |
| Nullable telemetry | `Entity` | retain attribution | retain original; canonical is a read projection | `AiUsage` when one subject exists |
| Workflow evidence | typed payload or `StoredFile` | workflow-specific retention | workflow-specific | import claims, hunt/mail file evidence |
| Non-entity polymorphism | existing typed union | existing policy | existing policy | targets that include `import_run` or external records |

The migration of a `(type, id)` pair is justified by its class, not by its
shape. Remove `entityType` only when joining `Entity.kind` preserves the
consumer's query and index needs. A denormalized checked kind may remain for a
measured query plan, but `Entity` is still the referential authority.

Historical rows always retain the identity that actually received the event.
For example, an `AuditLog` written against a merge loser keeps the loser's
`entityId`; an audit read may additionally expose `canonicalEntityId`. Repointing
old audit events to the survivor would falsify attribution.

## Public and generated contracts

Update the entity compiler rather than creating a second handwritten roster.
The entity declaration remains authoritative for:

- shortcode prefix and payload table;
- payload-retention policy;
- allowed attachment roles and document kinds;
- direct and related display-image sources;
- delete/merge capabilities and operation owner; and
- logical typed relationships and their mutation adapters.

Generate:

- `Entity.kind` values and prefix checks;
- typed extension identity columns/FKs/checks;
- live-payload constraint-trigger branches;
- the shortcode/payload binding map;
- attachment-role validation data;
- file-liveness registry coverage; and
- integrity detector rosters and contract cases.

The `executeEntity(context, command)` interface remains the external kernel
seam. Repositories continue to own transactions, locks, collision behavior,
and mutation ordering. The kernel may gain normalized memo and attachment
commands, but a relationship's presence in inspector metadata never implies a
write command.

Generic detail output gains:

- `redirectedFrom: string | null`;
- `previousShortcodes: string[]`;
- `memo: string | null`; and
- `attachments: EntityAttachmentRead[]`.

The stored-file rename requires synchronized schema, OpenAPI, browser, MCP, and
Apple regeneration. Preserve `IMG-` URLs. Compatibility aliases are input-only
and have an explicit removal checkpoint; new output uses the final name.

## Implementation plan

Treat each phase as a separately verifiable checkpoint even if the work is
reviewed as one large change. Production DDL has one exclusive owner. Follow
expand -> backfill -> switch -> cleanup; never point `db:push` at this plan and
approve its inferred drops.

### Phase 0: freeze the contract and measure the baseline

1. Write ADR 0004 reconciling this identity/file model with ADR 0001. State
   that `Entity` is an identity spine and `EntityAttachment` is a typed file
   association, not generic domain edge storage.
2. Snapshot the generated shortcode roster, row counts by kind, duplicate and
   orphan counts, hard-delete call sites, direct entity inserts, all
   `(entityType, entityId)` pairs, and all FKs to `Image`.
3. Record query plans and latency for shortcode resolution, global search,
   detail attachment reads, display-image selection, and file reaping.
4. Add contract tests for the target resolver states, mutation refusal through
   old codes, path compression, tombstones, attachment singularity, workflow
   file retention, and historical audit attribution before changing storage.
5. Define one verified write-freeze gate covering browser, HTTP/MCP, Apple,
   queues, cron, imports, maintenance actions, and scripts. Enumerate and test
   each producer rather than relying on a banner or a general maintenance-mode
   assumption. The freeze begins before Phase 2's first backfill read and ends
   only after Phase 3's new writers are deployed and its final reconciliation
   passes.

Exit: every writer, reference pair, and file-liveness source is classified;
the migration manifest has an owner and exact counts.

### Phase 1: expand the schema

1. Add `Entity`, `EntityMemo`, the stored-file extension identity columns, and
   `EntityAttachment` without removing current columns or tables. During
   expansion, the existing physical `Image` row is the StoredFile payload; do
   not create a second copy of mutable file status/metadata.
2. Add indexes for canonical shortcode lookup, survivor reverse lookup,
   subject attachment order, file liveness, and active singular roles.
3. Add generated extension-kind columns as nullable and with no non-null
   default while old writers still run. Do not add the composite payload FK
   yet: `NOT VALID` skips validation of old rows but still enforces new writes,
   which would fail before old writers create `Entity` rows.
4. Add reference columns to selected history/cache/telemetry tables alongside
   their existing pairs. Add paired-null checks where nullable attribution is
   permitted.
5. Add the generated deferred invariant trigger in audit-only/reporting mode
   until the backfill is complete.

Exit: old deployed code continues to read and write successfully; no existing
constraint has been weakened. Enter the verified write freeze before Phase 2.

### Phase 2: backfill identity and files

1. Stream every shortcode table into `Entity` using the existing UUID,
   canonical code, declared kind, creation time, and deletion state. Verify
   exact per-kind equality and no canonical-code collisions.
2. Reconstruct known merge redirects from unambiguous merge audit evidence.
   Produce a review file for ambiguous or bodiless history instead of guessing.
3. Treat each existing `Image` row in place as the StoredFile payload and
   backfill its Entity extension identity. File metadata/status continues to
   have one physical owner throughout migration.
4. Convert the eight gallery tables, Cookbook cover, and Vendor logo into
   `EntityAttachment` rows. Preserve ordering and purchase `documentKind`.
   Transfer an old target-scoped idempotency key only onto the matching live
   association; report targeted-but-detached rows and leave their keys behind.
5. Backfill `Entity` FKs for each approved history/cache/telemetry table and
   report unresolved rows by policy class.
6. Populate every extension-kind column, install its constant default, set it
   `NOT NULL`, add the composite payload FKs as `NOT VALID`, and then validate
   them. Run the live-payload and file-liveness detectors against the complete
   backfill before validation. `NOT VALID` is only a scan-timing tool here, not
   a compatibility mechanism for new writes.

Exit: every live payload has one correct identity; every old direct attachment
has an equivalent new row; unresolved history is explicitly accounted for.

### Phase 3: deploy synchronized writers and reconcile

Keep the write freeze active for this entire phase.

1. Change `insertWithShortcode` and find-or-create allocation to create Entity
   and payload rows atomically. Remove bypasses, including restore/idempotent
   file paths, or route them through explicit migration-only helpers.
2. Move delete/merge identity writes into the shared in-transaction lifecycle
   tail so hard payload deletion cannot skip tombstoning.
3. Dual-write attachments from current image mutations while reads still
   compare old and new projections. Stored-file create, upload promotion,
   metadata/status update, and delete continue to mutate the single in-place
   payload rather than mirroring two file tables.
4. Dual-write approved reference-policy consumers.
5. Add differential checks that compare old and new resolver, attachment,
   display-image, and liveness results on every affected test fixture.

6. Deploy every server writer, restart consumers with snapshotted registries,
   drain or discard pre-freeze queued messages according to their idempotency
   contracts, then run a final complete backfill/reconciliation from a stable
   database state.

Exit: all production writers maintain both representations, final drift is
zero, and no old server process can write. End the freeze only now; observe one
full background/import cycle before removing dual writes.

### Phase 4: switch reads and behavior

1. Switch read and mutation shortcode resolution to their distinct interfaces.
2. Return redirect metadata and tombstone states through browser, HTTP, MCP,
   and native contracts; update old merge-404 tests into named redirect and
   mutation-refusal regressions.
3. Switch gallery/cover/logo reads, detail attachments, display images, upload
   association, reorder, detach, and file reaping to `EntityAttachment` and the
   exhaustive liveness registry.
4. Switch approved history/cache/telemetry consumers to `Entity` FKs and the
   declared merge/delete policy.
5. Enable memo read/write in the generic entity interface without replacing
   payload-specific notes.
6. Enable the deferred live-payload constraint trigger as an enforced commit
   invariant.

Exit: no runtime read or write depends on the legacy lifecycle columns, image
join tables, cover/logo columns, or approved untyped reference pairs.

### Phase 5: cleanup and rename

1. Remove legacy dual writes and comparison telemetry after a measured clean
   interval.
2. Drop the eight image joins and singular cover/logo FKs, then remove their
   declaration/generator branches and handwritten bindings.
3. Remove copied shortcode/lifecycle columns from typed payload tables only
   after deployed code no longer selects them. Drop old untyped pair columns
   only for consumers that completed the reference-policy migration.
4. Perform the in-place physical `Image` -> `StoredFile` rename under a brief,
   separate coordinated access gate spanning the DDL, matching server deploy,
   registry/worker restarts, and a read/write smoke test. Preserve the single
   physical payload; do not let either old SQL naming `Image` or new SQL naming
   `StoredFile` run against the wrong side of the rename. Remove temporary
   transport discriminants only after browser, OpenAPI/MCP, and Apple
   compatibility checks.
5. Update `docs/entities.md`, README shortcode/entity text, inspector wording,
   and `docs/todos.md`.
6. Re-run baseline query plans and record any retained denormalization justified
   by measured regression.

Exit: there is one authoritative representation for identity and direct file
attachments, and the removed code exceeds the new compatibility machinery.

## Validation

### Database and migration

- Exact per-kind payload/Entity counts before enforcing constraints.
- Zero live entities without exactly one correct-kind payload.
- Zero payloads without an Entity row.
- Zero duplicate canonical shortcodes.
- Zero redirect cycles or multi-hop chains; a redirect to a canonical identity
  deleted after the merge is valid and resolves to that tombstone.
- Exact old/new attachment parity by subject, file, role, order, and
  `documentKind`; every Purchase attachment remains classified.
- Zero stored files reaped while referenced by an attachment, import hunt, or
  mail attachment.
- Query-plan comparison for resolver, attachment list, display image, search,
  and reaper queries.

### Behavioral contracts

- A canonical code reads the live entity with no `redirectedFrom`.
- Every old merge-loser code reads the canonical entity and reports the
  requested code.
- If that canonical entity is later deleted, its own code and every old loser
  code return the same minimal tombstone; none becomes mutable or missing.
- Update/delete/merge/attach/detach through a loser code is refused.
- A deleted non-merged code returns a minimal tombstone and cannot mutate.
- Cross-kind payload insertion and cross-kind merge fail transactionally.
- Merge path compression leaves one-hop redirects and preserves every old code.
- Audit rows retain original attribution and separately expose canonical
  resolution.
- Keeper singular attachment wins; loser singular attachment is demoted and
  retained.
- Repeating an attachment idempotency key reuses only an active association for
  that subject; detach frees the key, and merge never transfers loser-scoped
  keys to the survivor.
- Purchase duplicate-file merges preserve equal classifications, prefer a
  specific classification over `other`, and refuse conflicting specific
  classifications without explicit resolution; primary-document results do
  not change accidentally.
- An attachment used by two entities survives either entity's deletion.
- A workflow-only file survives without an `EntityAttachment`.
- Existing domain FK, merge, delete, reporting, and uniqueness behavior remains
  unchanged.

### Repository gates

- Run generators rather than editing generated schema, route, OpenAPI, or Swift
  artifacts by hand.
- Run focused resolver, merge, deletion, attachment, display-image, search,
  audit, import, and reaper tests.
- Run schema/integrity integration tests against PostgreSQL.
- Rebuild and verify the IntegreSQL schema template after schema inputs change.
- Run `pnpm typecheck`, `pnpm check`, the affected fast-test graph, generated
  checks, and built-browser tests.
- Regenerate and validate the Apple client after the OpenAPI contract changes.
- Require GitHub Actions to pass on the exact final PR head before merge.

## Failure and recovery

The migration is forward-only, but every destructive step follows a verified
read switch. Before cleanup, recovery means switching reads back to the legacy
representation while dual writes continue. After cleanup, recovery means
restoring from the database/object-store backup taken at the cutover gate and
redeploying the prior compatible build; there is no row-level user undo.

Stop the cutover if any of these occur:

- per-kind identity counts diverge;
- attachment parity or file-liveness checks diverge;
- the deferred payload invariant finds a live orphan;
- a writer bypasses the dual-write seam;
- redirect resolution creates a cycle or changes a mutation target; or
- representative query plans regress without an understood index fix.

## Follow-ups intentionally cut from this redesign

These are detailed backlog candidates, not hidden requirements for the identity
or file migration.

### 1. Generic relationship editor over declared adapters

Goal: let a user inspect and mutate supported relationships from a shared UI
without inventing generic edge storage.

Promote when at least two typed relationships need the same attach/detach or
replace interaction beyond file attachments.

Work:

1. Extend entity declarations with an explicit editor presentation contract
   only for relationships that already have a typed mutation adapter.
2. Generate client-safe capability metadata and server-only adapter dispatch.
3. Build one picker/list/editor that invokes `executeEntity` relation commands;
   never write tables from metadata.
4. Define per-relation cardinality, replace-versus-append semantics, ordering,
   validation errors, merge/delete interaction, and audit wording.
5. Make unsupported catalog relationships visibly read-only rather than
   heuristically mutable.
6. Validate web, MCP exposure where explicitly allowed, and native parity only
   for relationships each client actually supports.

Acceptance: adding a supported editor requires one declaration plus one typed
adapter, transaction semantics remain repository-owned, and no universal
`EntityRelation` table exists.

### 2. Selective conversion of remaining polymorphic references

Goal: retire an untyped pair only when a real FK and shared lifecycle policy
improve that consumer.

Promote one table at a time after classifying it in the reference-policy
registry. Candidate families include import mutations/findings and data-quality
records, but targets that include `import_run`, external USDA rows, or other
non-entities may correctly remain typed unions.

For each candidate:

1. Prove whether the row is history, cache, telemetry, workflow evidence, or an
   operational relationship.
2. Decide whether it attributes the original identity or follows the survivor.
3. Add a nullable/additive Entity FK and paired-null constraints.
4. Backfill without guessing unresolved targets.
5. Compare query plans and indexes before removing a denormalized kind.
6. Add delete/merge tests specific to the declared policy.

Acceptance: no raw pair remains merely from inertia, and no pair is converted
merely because its columns look polymorphic.

### 3. Manual aliases and imported legacy identifiers

Goal: support a genuine old public code that is neither a merge loser nor one
of the fixed prefix aliases.

Promote only when real links cannot be reconstructed through Entity tombstones
and merge audit. If needed, add a narrow `EntityAlias(code, entityId, source,
createdAt)` table with immutable, globally unique codes. Alias reads redirect;
all mutations through aliases refuse. Do not expose alias editing until there
is a concrete household workflow and a collision-review UI.

Acceptance: aliases never change canonical output, never permit cross-kind
mutation, and cannot shadow canonical or fixed-prefix codes.

### 4. Rich notes, comments, or entity timeline

Goal: add multiple authored entries, chronology, or structured annotations if
the one-current-summary memo proves insufficient.

Promote when a real entity needs multiple independently meaningful notes or
authorship/history. Design this as its own domain model with retention, merge,
search, and visibility semantics. Do not stretch `EntityMemo` into a JSON
timeline or overload `AuditLog` as user-authored content.

Acceptance: the new model answers who/when/order/merge behavior explicitly and
`EntityMemo` remains a single replaceable summary.

### 5. Broader generic file workflows

Goal: reuse one upload/preview/download pipeline for all supported MIME types,
including promotion of workflow evidence into entity attachments.

Promote after the shared attachment migration is stable. Add explicit workflow
commands such as “attach this mail PDF to Purchase” that create an attachment
without deleting the workflow evidence reference. Expand MIME support only with
decoder/preview, integrity, object-store, and client behavior specified.

Acceptance: workflow provenance remains intact, file liveness remains
exhaustive, and unsupported MIME types degrade to safe download metadata rather
than pretending to be images.

## Final decision test

Proceed only if the implementation preserves these boundaries:

- Identity can be generic because every entity needs durable naming and
  lifecycle.
- Files can be M:N because the same immutable stored file can legitimately be
  attached to multiple entities in multiple supported roles.
- Domain relationships are not generic unless their business semantics are
  genuinely identical.
- Relationship metadata describes and dispatches declared behavior; it does
  not create behavior.
- Historical truth keeps the original identity while read models may also
  resolve the canonical survivor.

If implementation starts adding arbitrary JSON edge metadata, converting typed
FKs solely for uniformity, or teaching callers the internal payload/redirect
machinery, stop and re-scope. That would be a different architecture from the
one approved here.
