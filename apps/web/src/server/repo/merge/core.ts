/**
 * The shared mechanics of every entity merge.
 *
 * Four merges exist (`mergeIngredients`, `mergeVendors`, `mergePurchases`,
 * `mergeProducts`) and their *public contracts* deliberately differ —
 * `mergeIngredients` predates the shortcode cutover, so it takes uuids, has no
 * actor, hard-deletes, and returns a summary. Unifying those signatures would
 * ripple into routers, MCP tools, and tests for no gain. What they genuinely
 * share is the machinery *underneath* the contract, and that is what lives
 * here:
 *
 *  - {@link resolveMergeTargets} — shortcode → id resolution plus the
 *    keeper/loser split and the fail-loud-on-a-missing-id rule.
 *  - {@link repointEdge} — re-point one *declared* incoming edge, looked up
 *    from `INCOMING_EDGES` by edge key so the column can't be mis-wired.
 *  - {@link finalizeMerge} — remove the losers. **This is the reason the module
 *    exists.**
 *
 * ## Why `finalizeMerge` is not optional
 *
 * The removal-path invariant (root CLAUDE.md) says every path that removes an
 * entity must cascade its `EntityEmbedding` rows in the same transaction.
 * `mergeIngredients` simply forgot to, and nothing structural stopped it — the
 * omission shipped and was patched instance-by-instance in #591. So the loser
 * removal and the embedding cascade are now **one function call**: there is no
 * way to write a merge that deletes its losers without also cascading their
 * embeddings, because the delete and the cascade are the same statement pair
 * and the cascade is derived from the entity, not passed in. A future merge
 * that forgets it is not a test failure waiting to happen — it is unwritable.
 *
 * The cascade tail itself now lives in `repo/removal` — `cascadeRemoval` is the
 * same mechanism generalized to the non-merge removal paths, and it owns the
 * only mint site for a delete audit entry. `finalizeMerge` keeps the row
 * removal (its statement order is load-bearing for `mergeProducts`) and
 * delegates the tail.
 *
 * ## What deliberately stayed per-entity
 *
 * Which columns carry over, which rollups recompute, which collisions are
 * legal, and what the audit `changes` record is called (`mergedFrom` on a
 * vendor merge, `foldedIn` on a purchase fold) are all genuinely different per
 * entity. They are parameters or plain caller code, not core behavior — a core
 * that forced three different things into one shape would be worse than the
 * duplication it replaced.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { Entity } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { BrandForEntity } from "@cubby/schemas/identifiers";
import { type AnyColumn, and, getTableColumns, inArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import type {
  IncomingEdge,
  IncomingEdgeKey,
} from "~/server/db/entity-incoming-edges";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import type { AuditEntryInput } from "~/server/repo/audit-log";
import { logAuditEntries } from "~/server/repo/audit-log";
import { notDeleted } from "~/server/repo/database-helpers";
import type { RemovableEntity } from "~/server/repo/removal";
import { cascadeRemoval } from "~/server/repo/removal";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";

/** A table a merge can remove rows from — soft (`deletedAt`) or hard. */
type MergeableTable = PgTable & { id: AnyColumn; deletedAt: AnyColumn };

/** Audit `changes` payload, matching {@link logAuditEntries}' entry shape. */
type MergeAuditChanges = Record<string, { from: unknown; to: unknown }>;

/**
 * Resolve `{keepId, mergeIds}` shortcodes to entity ids, failing loudly when
 * any of them doesn't name a live row.
 *
 * The keeper is dropped from the loser set (merging a record into itself is a
 * no-op, not a delete), and duplicates collapse — so a caller that receives
 * `keepId` twice can't soft-delete the survivor.
 *
 * Fail-loud is the point: silently skipping an unresolvable id returns
 * "success" while changing nothing, which is how a typo'd code reads as a
 * completed merge.
 *
 * The error reason, the message label, and the id brand are all derived from
 * `entity` via `resolveAllOrThrow` — this used to take all three as arguments,
 * which meant every caller could pair a `"vendor"` merge with a
 * `PRODUCT_NOT_FOUND` reason or another entity's brander and still compile.
 */
export const resolveMergeTargets = async <E extends ShortcodeEntity>(
  db: Database,
  args: {
    entity: E;
    keepId: string;
    mergeIds: readonly string[];
  },
): Promise<{ keepId: BrandForEntity<E>; loserIds: BrandForEntity<E>[] }> => {
  const codes = uniq([args.keepId, ...args.mergeIds]);
  // Deduped on the way in, so the positional result maps back cleanly — and a
  // caller that passed the keeper twice can't have it counted as a loser.
  const ids = await resolveAllOrThrow(db, args.entity, codes);
  // Explicitly generic: left to infer, `Map` widens `BrandForEntity<E>` into a
  // union of all fifteen brands, which then can't flow back into the deferred
  // `BrandForEntity<E>` the signature promises.
  const byCode = new Map<string, BrandForEntity<E>>(
    codes.map((code, i) => [code, ids[i]!]),
  );
  const keepId = byCode.get(args.keepId)!;
  const loserIds = uniq(args.mergeIds.map((code) => byCode.get(code)!)).filter(
    (id) => id !== keepId,
  );
  return { keepId, loserIds };
};

/**
 * The Drizzle column behind a declared incoming edge.
 *
 * Looking the column up from `INCOMING_EDGES` — rather than letting each call
 * site name it — closes the "residual weakness" `product/edge-roles.ts`
 * documents: declaring an edge in a policy forced each consumer to have *an
 * entry* for it, but nothing stopped that entry from being wired to the wrong
 * column. Here the edge key IS the column.
 */
const edgeColumn = <E extends Entity>(
  entity: E,
  edgeKey: IncomingEdgeKey<E>,
): PgColumn => {
  const edges = INCOMING_EDGES[entity] as unknown as Record<
    string,
    IncomingEdge | undefined
  >;
  const edge = edges[edgeKey as string];
  if (!edge) {
    throw new Error(`No incoming edge ${String(edgeKey)} on ${entity}`);
  }
  return edge.column as PgColumn;
};

/**
 * Re-point one declared incoming edge from the merged-away ids onto the
 * survivor, returning the ids of the rows that moved (for audit entries).
 *
 * `liveOnly` is required rather than defaulted because both answers are
 * correct somewhere and getting it wrong is silent:
 *  - `false` — every row, soft-deleted ones included. What a HARD delete of the
 *    loser needs, since the FK constraint applies to every row regardless of
 *    `deletedAt` (`mergeIngredients`).
 *  - `true` — live rows only. What a merge needs when it has *already*
 *    soft-deleted some source rows to vacate a unique-index slot; re-pointing
 *    those would walk straight back into the collision the fold just resolved
 *    (`mergeVendors`).
 */
export const repointEdge = async <E extends Entity>(
  tx: DrizzleTransaction,
  entity: E,
  edgeKey: IncomingEdgeKey<E>,
  args: { from: readonly string[]; to: string; liveOnly: boolean },
): Promise<string[]> => {
  if (args.from.length === 0) return [];
  const column = edgeColumn(entity, edgeKey);
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle's column->table back-reference is untyped.
  const table = (column as any).table as MergeableTable;
  const columns = getTableColumns(table);
  const property = Object.keys(columns).find(
    (key) => columns[key as keyof typeof columns] === column,
  );
  if (!property) {
    throw new Error(
      `Could not resolve a column property for ${String(edgeKey)}`,
    );
  }

  const conditions = [inArray(column, [...args.from])];
  if (args.liveOnly) conditions.push(notDeleted(table));

  const rows = await tx
    .update(table)
    // biome-ignore lint/suspicious/noExplicitAny: dynamic single-column set, keyed by the edge's own property.
    .set({ [property]: args.to } as any)
    .where(and(...conditions))
    // biome-ignore lint/suspicious/noExplicitAny: AnyColumn is too narrow for returning().
    .returning({ id: table.id as any });
  return rows.map((row) => String(row.id));
};

/**
 * Remove a merge's losers: delete their rows, cascade their search embeddings,
 * and write the audit trail — as one indivisible step.
 *
 * The embedding cascade is derived from `entity` (searchable entities get one,
 * others don't) rather than passed in, so it cannot be forgotten, disabled, or
 * mis-targeted at the wrong entity type. A live `EntityEmbedding` pointing at a
 * merged-away id is permanent damage: there is no restore to heal it,
 * `findOrphanedEntityEmbeddings` flags it forever, and until then semantic
 * search keeps returning a result that renders blank.
 *
 * A hard-deleted row still gets a SOFT-deleted embedding — the same convention
 * `inventory/bulk.ts` uses for a collapsed source row. A soft-deleted embedding
 * is excluded from both semantic search and orphan detection, so one shared
 * cascade covers both removal modes rather than needing a hard-delete variant.
 *
 * `survivorChanges` is caller-supplied in full. The record's key is genuinely
 * per-operation vocabulary — `mergedFrom` naming an array on a vendor merge,
 * `foldedIn` naming one charge on a purchase fold — and normalizing it would
 * rewrite a trail that is already the historical record.
 *
 * The ids are branded to `entity` rather than a free `Id extends string`, so
 * `{entity: "vendor", loserIds: productIds}` no longer compiles — the same lock
 * {@link cascadeRemoval} applies, and what lets the tail below delegate to it
 * without a cast.
 */
export const finalizeMerge = async <E extends RemovableEntity>(
  tx: DrizzleTransaction,
  args: {
    entity: E;
    table: MergeableTable;
    keepId: BrandForEntity<E>;
    loserIds: readonly BrandForEntity<E>[];
    /** `hard` is `mergeIngredients` only; every other merge soft-deletes. */
    removal: "soft" | "hard";
    /** Omit for a merge with no actor context (`mergeIngredients`). */
    actor?: ActorContext;
    /** Recorded on the survivor's `update` entry. No entry is written when empty. */
    survivorChanges?: MergeAuditChanges;
  },
): Promise<void> => {
  const { entity, table, keepId, loserIds, removal, actor } = args;
  if (loserIds.length === 0) return;
  const ids = [...loserIds];

  // The row removal stays here rather than moving into `cascadeRemoval`:
  // removal differs per entity (soft for products/purchases/vendors, hard for
  // ingredients) and its position relative to a caller's own writes can be
  // load-bearing when a partial unique index is involved. Only the tail —
  // cascade plus delete entries — is shared.
  if (removal === "hard") {
    await tx.delete(table).where(inArray(table.id, ids));
  } else {
    await tx
      .update(table)
      // biome-ignore lint/suspicious/noExplicitAny: dynamic soft-delete over a structurally-typed table.
      .set({ deletedAt: new Date() } as any)
      .where(and(inArray(table.id, ids), notDeleted(table)));
  }

  // A merge with no actor context (`mergeIngredients`) still has to cascade, so
  // the entries go to a local buffer that is only flushed when there IS one.
  // That is the one difference from every other removal path — and the reason
  // `cascadeRemoval`'s audit sink is mandatory rather than optional.
  const entries: AuditEntryInput[] = [];
  const survivorChanges = args.survivorChanges ?? {};
  if (actor && Object.keys(survivorChanges).length > 0) {
    entries.push({
      entityType: entity,
      entityId: keepId,
      action: "update",
      changes: survivorChanges,
    });
  }
  await cascadeRemoval(tx, { entity, ids, audit: { into: entries } });
  if (!actor) return;
  await logAuditEntries(tx, actor, entries);
};
