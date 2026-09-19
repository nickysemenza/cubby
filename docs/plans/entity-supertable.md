# `Entity` supertable — tabled

Status: **tabled 2026-09-19**, not scheduled. Designed during the purchase
import grilling, reviewed adversarially against the checkout and read-only
counts from production, and set aside because the cost is out of proportion
to what the household would feel. Kept so the next time a polymorphic table
or a merge-redirect request appears, the work starts from here instead of
from zero. No ADR yet; the decision is "not now", not "never".

## The idea

One row per entity of any kind, so a polymorphic reference can be a real
foreign key that carries the type:

```text
Entity(id uuid PK, kind text, body text, createdAt, deletedAt,
       mergedIntoId uuid → Entity.id)
  UNIQUE (id, kind)      -- lets a composite FK enforce existence AND type
  UNIQUE (kind, body)    -- shortcode allocation in one place
AiUsage(entityId, entityType) REFERENCES Entity(id, kind)
```

- `entityRef` — a schema helper emitting the `(<x>Id, <x>Type)` pair with the
  composite FK and an optional CHECK narrowing `<x>Type`; the one shape for
  "points at any of several".
- Allocation — `insertWithShortcode` inserts the `Entity` row first and uses
  its id; per-table `shortcode` columns stay as denormalised copies.
- Merge redirects — `finalizeMerge` sets `mergedIntoId` on losers; shortcode
  resolution follows it, so an absorbed code in a URL, note, MCP client, or
  audit row forwards to the survivor. This is the part a user would feel.
- Registry — an `entityRef` table declares a role (`history` keep on delete
  and on merge; `cache` reap / re-point; `attached` reap / re-point /
  counted) instead of per-kind edges.

## What the review found (verified)

Numbers are from production on 2026-09-19: 38,814 entity rows across the 20
shortcode tables; 56,031 `AuditLog`; 136,044 `AiUsage`; 30,192
`SearchDocument`; 10,563 `EntityEmbedding`.

1. **Entities are hard-deleted on two paths.** `removeEntity` has a `"hard"`
   mode for the entity's own row (`repo/removal/entity.ts:289`), used by
   ingredient merges (`repo/ingredient/merge.ts:387`) and inventory
   consolidation (`repo/inventory/bulk.ts:731`). The design's "permanent
   tombstone" premise therefore needs tombstoning to happen in
   `cascadeRemoval` (the one tail every path calls), not `removeEntity`.
   Residue today: 854 orphan `AuditLog` rows over 609 subjects (528
   inventory, 197 product, 50 ingredient), 44 orphan `AiUsage`, 43
   soft-deleted `SearchDocument` orphans.
2. **Backfill tombstones have no body.** Orphaned history rows carry only a
   uuid. `body` would have to be nullable (PG treats NULLs as distinct in a
   unique) and a bodiless tombstone renders as the raw uuid — which
   `audit-log.ts` already does for unresolved values.
3. **`UNIQUE (body)` can never happen.** 623 cross-kind body collisions
   exist (616 shared bodies, 7 shared by three or more kinds). The body is 4
   chars over a 31-symbol alphabet (923,521 codes); global occupancy is 4.2%
   now and would be ~42% at 10× growth. `UNIQUE (kind, body)` is final.
4. **Redirect-following inside the typed resolver causes a self-merge.**
   `resolveMergeTargets` (`repo/merge/core.ts:54-79`) checks distinctness on
   *codes*, then resolves; if B was earlier absorbed into A, merging
   `keep=A, mergeIds=[B]` resolves B→A and soft-deletes the keeper. Merge,
   delete, attach/detach, and `resolveFilterIds` need a non-redirecting
   resolver that refuses redirected codes; distinctness must be checked on
   resolved ids.
5. **Redirects change asserted behaviour.** `purchase.integration.test.ts:513`
   and `vendor.integration.test.ts:389` assert a merged loser resolves to
   nothing. Surfaces must be chosen explicitly (routes, MCP `get`, global
   search redirect; mutations do not) and a `redirectedFrom` marker returned
   so the UI can say "merged into X".
6. **Two production insert paths bypass `insertWithShortcode`.** Product
   restore replays an explicit code via `insertAndReturn`
   (`repo/product/crud.ts:2112`); the image idempotent insert uses
   `generateUniqueShortcode` then a raw `onConflictDoNothing`
   (`repo/image.ts:2306`). Both would leave a live `Entity` row with no
   entity row. The `Entity` insert must live in the same savepoint as the row
   insert. Nine test files also insert entity rows directly.
7. **The edge registry does not fit "one edge for every kind".** Keys are
   `${table}.${column}` per target entity, checked by `WellKeyed`; 28
   `satisfies IncomingEdgePolicy` sites must name every key, and
   `EXPECTED_EDGE_COUNT` plus the product retaining-edge builders would be
   polluted. A separate `ENTITY_REF_TABLES` registry with three generic role
   executors is the workable shape — which means two registries, not one.
   `entity-manifest-fk.unit.test.ts` would also need `Entity` in
   `NON_ENTITY_FK_TARGETS`.
8. **`db:push` cannot do the migration.** `NOT VALID … VALIDATE` and CHECKs
   are hand-applied with the exact names drizzle would generate; dev
   `DATABASE_URL` is production. Sequence: create `Entity` (push) →
   backfill script → FKs `NOT VALID` → reap/tombstone orphans → `VALIDATE` →
   deploy the writing code.
9. **Composite-FK null handling.** `AiAnalysis` uses `('global', NULL)`;
   `AiUsage` has 2,190 rows with null `entityType`. `MATCH SIMPLE` skips the
   check when either column is null, so each table needs
   `CHECK ((entityId IS NULL) = (entityType IS NULL))` or an explicit
   allowance.
10. **Chains and cycles.** Path-compress at merge time
    (`UPDATE Entity SET mergedIntoId = :survivor WHERE mergedIntoId IN
    (:losers)`), `CHECK (mergedIntoId <> id)`, and require the survivor be
    live and unredirected in the same transaction.
11. **`Image.targetType/targetId` is a sixth untyped pair**, and it is
    generated (`entity-columns.gen.ts`), so `entityRef` would have to be
    emitted by `scripts/generator/entities`.
12. **ADR-0001** says Cubby introduces no EAV or generic edge table; an ADR
    for this must say why a supertable with composite FKs is not that.
13. **Cost per create** goes from two round trips to three unless the
    advisory pre-check is dropped in favour of `INSERT … RETURNING` as the
    collision probe; `Entity` must supply the uuid, so every insert passes an
    explicit `id`.

## Why it is tabled

The benefit a person feels is merge redirects, and that needs a
`mergedIntoId` (or a three-column redirect table) written by `finalizeMerge`
and consulted on resolver miss — about a day, no backfill, no composite FKs,
and it still needs the resolver split in finding 4. Typed FKs on rebuildable
caches and on history tables enforce invariants the data shows already hold
(zero live orphans in search and embeddings); global uniqueness solves
nothing the prefixes do not. Tenet 4 puts speed and recoverability over
correctness ceremony, and this is roughly a week of ceremony plus a
production backfill.

## When to revisit

- A second consumer that needs FK integrity on "any entity" — comments or
  notes on anything, or the image join tables becoming a real cost.
- Hard deletes being removed from ingredient merge and inventory
  consolidation, which would restore the tombstone premise.
- Merge redirects landing on their own and the resolver split (finding 4)
  already existing — at that point the supertable is a backfill plus FKs,
  not a redesign.

## If revived: definition of done

Findings 1–13 each addressed in the plan before code; `Entity` row inserted
inside the same savepoint as every entity insert, with a lint forbidding
`.insert(<entity table>)` outside `shortcode-utils.ts`; FKs only on cache
and attached tables, history tables covered by a `pnpm check` orphan
detector; `ENTITY_REF_TABLES` registry with role executors; hand-applied
migration script with per-kind row-count verification against `Entity`;
IntegreSQL template rebuild; the two redirect tests rewritten as named
regressions; ADR-0004 written with the ADR-0001 reconciliation.
