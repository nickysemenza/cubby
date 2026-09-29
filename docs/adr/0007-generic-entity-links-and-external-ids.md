# ADR 0007: One entity link table and one external identifier table

Status: Accepted. Supersedes in part ADR 0001 and ADR 0006, which ruled out a
generic edge table.

## Context

Seven join tables — `WishCandidate`, `PurchaseProduct`, `ProjectToolUsage`,
`GardenEntryPlanting`, `ProductComponent`, `TaskDependency`, and
`ProjectDependency` — had the same shape (two entity ids, timestamps, and for
one of them a quantity) and separate copies of the same code: repository,
merge repoint, delete policy, edge-source branch, and provenance strings. The
dependency tables had no `deletedAt`, so a removed dependency was a hard delete
with nothing to restore or audit.

Identifiers from outside systems were scattered the same way: a
`ProductExternalId` table, a `sourceRefs` jsonb array on `FinancialTransaction`,
Notion page id columns on `Expense`, `Task`, and `Project`, a Drive folder URL
on `Project`, and a Notion page id inside `Recipe.SourceData`. Source names were
free text spelled inconsistently across five tables (`authorize.net` in some,
a different slug elsewhere), and a jsonb array cannot carry a unique index.

ADR 0001 and ADR 0006 both rejected a generic edge table. Their reasoning held
for a table of every local edge; it does not hold for edges that are pure
pairings of two entities with no payload of their own.

## Decision

### EntityLink

`EntityLink(id, kind, fromEntityId, fromKind, toEntityId, toKind, quantity,
createdAt, updatedAt, deletedAt)` holds every many-to-many pairing of two
entities. The link kinds are the keys of `ENTITY_LINK_KINDS` in
`packages/schemas/src/entity-links.ts`: `wishCandidate`, `purchaseProduct`,
`projectTool`, `gardenEntryPlanting`, `productComponent`, `taskDependency`,
`projectDependency`. `from` is the owning side: the wish, the order, the
project, the garden entry, the kit, the blocked task or project.

Each kind declares its two endpoint entity kinds, whether it carries a
quantity, whether a self-link is forbidden, whether cycles are refused, and a
per-end record of role, label, description, liveness, and merge behavior. The
database enforces what it can:

- Composite FKs `(fromEntityId, fromKind)` and `(toEntityId, toKind)` to
  `Entity(id, kind)`, so an endpoint must exist and be of the stated kind.
- `EntityLink_kind_check` limits `(kind, fromKind, toKind)` to the declared
  triples; `EntityLink_quantity_check` requires an integer of at least 1 on
  `productComponent` and NULL elsewhere; `EntityLink_no_self_check` refuses
  `from = to` for the kinds that forbid it. The three bodies are rendered from
  the declaration by `server/db/entity-link-schema.ts`, so a new kind changes
  one file and `db:check` diffs the result.
- A live unique index on `(kind, fromEntityId, toEntityId)` and an index on
  `(toEntityId, kind)`, both partial on `deletedAt IS NULL`. A soft-deleted
  duplicate may coexist with a live link, which is what makes restore and
  re-add work.
- A constraint trigger, `EntityLink_live_endpoints`, refuses a live link whose
  endpoint `Entity` is deleted. It guards link writes only; deleting an entity
  with live links remains the delete policy's job.

Dependencies became soft-deletable in the same move. Cycle detection stays in
`repo/database-helpers/dependency-edges.ts`, because a cycle is a graph
property no row constraint can express. Each per-domain repository keeps its
own validation and refusals and calls the shared helpers in
`repo/entity-links.ts` for the rows; every helper names its link kind, since
`toEntityId` alone matches a product's purchase, tool, wish, and component
links at once.

Merge behavior is per end: `onMergeCollision` on the end being merged decides
what happens when repointing the loser's links collides with a live link the
survivor already has. The modes are `dropLoser` (soft-delete the duplicate),
`sumQuantity`, and `dedupeEqualQuantityElseRefuse` (drop when quantities match,
otherwise refuse the merge rather than invent or destroy units). Only
`productComponent` is asymmetric: merging a kit refuses on unequal quantities,
merging a part sums them. A merge that would create a self-link on a kind that
forbids it drops the link.

The physical graph read (`repo/entity-edge-source.ts`) gets one branch per kind
from the declaration, so connections, delete and merge impact previews, and
the graph explorer see links without hand-listed edges. Edge keys read
`EntityLink[kind].from|to`.

### EntityExternalId and ExternalSource

`ExternalSource(slug, label, vendorId, createdAt)` registers every place an
identifier can come from. `slug` is a lowercase kebab-case slug (checked in the
table), `vendorId` names the Vendor when one matches. The seed is the union of
sources found in the old product identifier table, `sourceRefs`, statement
imports and rows, and ledger source claims, plus `notion` and `google-drive`,
after one spelling was chosen per source (`authorize.net` became
`authorize-net`). The `source` column of `EntityExternalId`, `StatementImport`,
`StatementRow`, and `LedgerSourceClaim` is an FK to the registry
(`ON UPDATE cascade`). Writers register a slug through
`ensureExternalSources` before using it.

`EntityExternalId(id, entityId, entityKind, source, kind, externalId, url,
isPrimary, createdAt, updatedAt, deletedAt)` holds every identifier an outside
system gave an entity. The kinds are the keys of `EXTERNAL_ID_KINDS` in
`packages/schemas/src/external-id.ts`, each declaring the entity kinds it may
attach to and whether it has a primary slot:

- Product identifiers: `asin`, `retailer_sku`, `internet_number`,
  `item_number`, `catalog_number`, `gtin_14`, `legacy_unspecified`.
- `settlement_ref` on `financialTransaction`: one card charge can name several
  orders, so it has no primary slot and `isPrimary` is NULL.
- `page` on expense, task, project, and recipe (Notion); `folder` on project
  (Drive).

The table enforces `(entityKind, kind)` against the declared pairs, `isPrimary`
NOT NULL exactly on kinds with a primary slot, and a 14-digit form for
`gtin_14`. Identifiers are globally unique among live rows on `(source, kind,
externalId)`, so an identifier names at most one live entity; primary is
unique per `(entityId, source, kind)` among live rows. One `gtin_14` kind
replaces one kind per encoding: values normalize to GTIN-14 at the write
boundary (`normalizeGtin` refuses input that is not 8 to 14 digits, because
Postgres `lpad` truncates longer input and a truncated value would collide with
a real barcode).

Rows soft-delete with their entity, in the same transaction, through the
entity's delete policy. That is what lets a settlement reference be recorded
again after the transaction that held it is deleted, and it is why the unique
index is partial. The `settlement_reference` predicate
(`repo/financial-reconciliation.ts`) reads live `settlement_ref` rows with `EXISTS`; the structured
`FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT` refusal stays a repository
pre-check, with the unique violation mapped to it as a backstop.

## Rejected alternatives

- Keep seven tables and share code only. The duplication was in the behavior
  (merge, delete, graph, provenance), and a shared helper still left seven
  places to update per change.
- A generic table for every local edge, including `EntityAttachment`,
  `FinancialTransactionAllocation`, and `MealRecipe`. Those rows carry payload
  (role, ordering, amounts, preparation) and their own unique indexes; forcing
  them through one table would move that payload into generic columns or a
  second table. Only pure pairings moved.
- A `kind` column per external id with no source registry. Source names would
  stay free text, and the five tables would keep spelling the same source
  differently.
- Primary slots for every kind. `settlement_ref` has many legitimate
  references per transaction and no meaning for "primary".

## Consequences

Adding a link kind is one declaration plus a migration that regenerates the
three CHECK bodies; adding an external id kind is one entry in
`EXTERNAL_ID_KINDS`. Queries that join a specific link must filter on `kind`
and `deletedAt`; the helpers in `repo/entity-links.ts` exist so callers do not
hand-write that. A link kind's meaning lives in the declaration, not in the
table name, so reading raw SQL requires knowing the kind.

The composite FKs need the endpoint's kind stored redundantly on every row;
the CHECK keeps it consistent with the kind's declaration. A live link to a
deleted entity is impossible to write but not impossible to strand: an entity
deleted while links remain relies on the delete policy to dispose them.

Uniqueness of external ids is global, not per entity kind: two entities cannot
claim the same `(source, kind, externalId)` live, which is the intended
identity rule and also the reason a merge must move or drop the loser's rows
rather than leave both.

Supersession: ADR 0001's "no generic edge table" and ADR 0006's rejection of a
generic `EntityRelation` no longer hold for the seven pairings above. Both
ADRs stay in force for typed FKs, per-operation lifecycle policy, and the
runtime edge source. ADR 0006's identity rule ("Entity rows are never
deleted") has one deliberate exception recorded in ADR 0005's amendment:
`ImageSighting` stopped being an entity, and its `Entity` rows were deleted
after their audit history moved onto the parent Image.
