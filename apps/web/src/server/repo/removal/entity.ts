/**
 * The front door `cascadeRemoval` is the tail of: remove an entity's own rows,
 * its declared child rows, and everything derived from them, in one call.
 *
 * ## Why this is a separate function rather than more of `cascadeRemoval`
 *
 * `cascadeRemoval` deliberately never touches the entity's own table, because
 * a handful of paths depend on *when* the row dies relative to something else
 * (`inventory/bulk.ts` hard-deletes emptied sources up front to free slot
 * keys). Those paths keep calling the tail directly. Everything else is the
 * same five statements in the same order, and that is what this function is.
 *
 * ## Why there are no callback hooks
 *
 * The shape it absorbs is linear on purpose: count children → remove children →
 * remove the parent → cascade + audit. Everything a delete path does *around*
 * that shape stays in the caller as plain code, because folding any of it in
 * would require a hook, and hooks would turn a readable sequence into a
 * framework whose control flow you have to reconstruct at every call site:
 *
 *  - **Locking and validation.** {@link removeEntity} takes ids that are
 *    already locked and cleared — a precondition, not a callback. Absorbing
 *    `lockAndValidateForDelete` would drag in id resolution (some sites resolve
 *    outside the transaction, some inside, some are handed ids), cascade
 *    expansion (`deleteTasks` adds subtasks to the id set), and per-site
 *    pre-mutations, each needing its own hook.
 *  - **Blocking guards and detaches.** Those are declared policy, applied
 *    by `applyDispositions` (`./dispositions.ts`) before this runs.
 *  - **Rich return values and in-transaction side effects.**
 *    `deleteExpensesWithPurchaseEffects` computes newly-empty purchases from
 *    post-delete queries; several sites call `touchDataQualityTargets` or
 *    `syncChangedEffectivePrices`. Those run in the caller's own transaction,
 *    which `withTransactionOn` guarantees this call joins.
 *  - **Staleness dispatch.** Zero of the removal paths do it here; it is the
 *    router's job, via `runMutationSideEffects`.
 */

import type { ActorContext } from "@cubby/schemas/context";
import {
  type EntityId,
  type ImageShortcode,
  imageId as imageIdSchema,
} from "@cubby/schemas/identifiers";
import { and, inArray, or, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, withTransactionOn } from "~/server/repo/database-helpers";
import {
  imageJoinColumnFor,
  reapUnreferencedImages,
} from "~/server/repo/image";
import { countByTarget } from "~/server/repo/impact";
import {
  type CascadeCounts,
  cascadeRemoval,
  type RemovableEntity,
} from "~/server/repo/removal/core";
import {
  SHORTCODE_TABLE,
  type ShortcodeTable,
} from "~/server/repo/shortcode-utils";

/** A table a `mode: "soft"` cascade can write `deletedAt` on. */
type SoftDeletableTable = PgTable & { deletedAt: PgColumn };

/**
 * The columns on a child table that point at the parent. Non-empty by type, so
 * the OR below always has at least one clause.
 *
 * A list rather than a single column because a dependency edge
 * (`ProjectDependency`, `TaskDependency`) references the parent from *either*
 * end, and both ends die with it. Deliberately a column list and not an
 * arbitrary predicate: an escape hatch that took a `SQL` would let a caller
 * remove rows the declared edge does not describe, which is the hand-written
 * delete this module exists to replace.
 */
type ParentColumns = readonly [PgColumn, ...PgColumn[]];

/**
 * One child edge to remove before the parent.
 *
 * The two arms differ in more than a flag. `auditKey` exists only on the soft
 * arm because counting a child means `countByTarget`, which *throws* on a table
 * with no `deletedAt` — the hard-delete-only tables (`ProjectDependency`,
 * `TaskDependency`) are exactly the ones that can't be counted. Encoding that
 * in the union makes the mismatch a compile error instead of a runtime one.
 */
export type ChildCascade =
  | {
      table: SoftDeletableTable;
      parentColumns: ParentColumns;
      mode?: "soft";
      /** Audit-change key for the per-parent count, e.g. `cascadedImages`. */
      auditKey?: string;
    }
  | {
      table: PgTable;
      parentColumns: ParentColumns;
      mode: "hard";
      /** Unreachable: see {@link ChildCascade}. */
      auditKey?: never;
    };

/** `ids` matched against any of the edge's parent columns. */
const parentMatches = (
  columns: ParentColumns,
  ids: readonly string[],
): SQL<unknown> => {
  const [first, ...rest] = columns;
  const match = (column: PgColumn) => inArray(column, [...ids]);
  if (rest.length === 0) return match(first);
  // `or` returns `SQL | undefined` for the all-arguments-undefined case; every
  // clause here is a real predicate, so it cannot be that case. The `or` (not a
  // hand-joined `sql`) is load-bearing: it parenthesizes the disjunction, which
  // the soft path's `and(where, notDeleted(...))` then depends on.
  const predicate = or(match(first), ...rest.map(match));
  if (!predicate) {
    throw new Error("A non-empty parent-column set produced no predicate");
  }
  return predicate;
};

type RowRemoval =
  | { table: PgTable; where: SQL; mode: "hard" }
  | { table: SoftDeletableTable; where: SQL; mode: "soft" };

/**
 * Issue one removal statement. Soft removal re-applies `notDeleted` so a row
 * already dead keeps its original `deletedAt` rather than having the timestamp
 * rewritten by a second delete.
 */
const removeRows = async (
  tx: DrizzleTransaction,
  removal: RowRemoval,
  at: Date,
): Promise<void> => {
  if (removal.mode === "hard") {
    await tx.delete(removal.table).where(removal.where);
    return;
  }
  const { deletedAt } = removal.table;
  await tx
    .update(removal.table)
    .set({ deletedAt: at })
    .where(and(removal.where, notDeleted({ deletedAt })));
};

const cascadingImageRowsSchema = z.array(
  z.object({ imageId: imageIdSchema.nullable() }),
);

/**
 * The images a child cascade is about to orphan, read BEFORE it runs.
 *
 * Timing is the whole point. A cascade soft-deletes its join rows, and a
 * tombstoned join row is (correctly) not a reference — that is what makes the
 * reap afterwards find them unreferenced. But it also means the ids are no
 * longer reachable through the association once the cascade has run, so they
 * have to be collected first.
 *
 * Which children are image attachments is not declared here: `imageJoinColumnFor`
 * answers it from `INCOMING_EDGES.image`, so a new gallery entity is covered
 * the moment it is declared there rather than when someone remembers this file.
 */
const collectCascadingImageIds = async (
  tx: DrizzleTransaction,
  children: readonly ChildCascade[],
  ids: readonly string[],
): Promise<string[]> => {
  const imageIds: string[] = [];
  for (const child of children) {
    const imageColumn = imageJoinColumnFor(child.table);
    if (!imageColumn) continue;
    const parentPredicate = parentMatches(child.parentColumns, ids);
    const childPredicate =
      child.mode === "hard"
        ? parentPredicate
        : and(parentPredicate, notDeleted(child.table));
    const rows = cascadingImageRowsSchema.parse(
      await tx
        .select({ imageId: imageColumn })
        .from(child.table)
        .where(childPredicate),
    );
    for (const row of rows) {
      if (row.imageId) imageIds.push(row.imageId);
    }
  }
  return uniq(imageIds);
};

/**
 * Remove `ids` of `entity`, its declared children, their search embeddings, and
 * the delete audit entries — atomically with whatever transaction is already
 * open, or in a new one.
 *
 * **Precondition:** `ids` are already locked (`lockAndValidateForDelete`) and
 * cleared by whatever blocking guards the entity has. This function issues no
 * guard of its own; it is the write half only.
 *
 * The parent table is derived from `SHORTCODE_TABLE[entity]` rather than
 * passed, which closes the hole where a caller could pair `entity: "vendor"`
 * with the `product` table and mis-file both the rows and the audit trail.
 *
 * Children are removed in declared order and *all* of them before the parent —
 * that ordering is fixed here rather than left to the caller's array, because
 * a parent removed first would leave the child counts describing rows that no
 * longer belong to it.
 *
 * ## Images are reaped, not just detached
 *
 * A child cascade onto one of `image`'s join tables leaves the `Image` row and
 * its R2 object behind — that is unreferenced bytes nothing can render, and it
 * accounted for 50 of the 133 orphans found in production. So any image the
 * cascade orphaned is deleted here too, and its R2 key comes back in
 * `detachedImageKeys` for the caller to drop **after the commit** (an object
 * delete has no rollback). Their public ids come back in
 * `deletedImageShortcodes`, so the mutation boundary can report every public
 * entity the cascade actually removed. Callers that own no images get empty
 * arrays and can ignore them; a caller that owns images and discards the keys
 * leaks the object.
 */
export const removeEntity = async <E extends RemovableEntity>(
  dbOrTx: Database | DrizzleTransaction,
  args: {
    entity: E;
    ids: readonly EntityId<E>[];
    removal: "soft" | "hard";
    actor: ActorContext;
    children?: readonly ChildCascade[];
    /** Counts the caller computed itself, merged over the derived ones. */
    extraCounts?: CascadeCounts;
  },
): Promise<{
  detachedImageKeys: string[];
  deletedImageShortcodes: ImageShortcode[];
  deleted: number;
}> => {
  const { entity, ids, removal, actor, children = [], extraCounts } = args;
  if (ids.length === 0) {
    return {
      detachedImageKeys: [],
      deletedImageShortcodes: [],
      deleted: 0,
    };
  }

  return await withTransactionOn(dbOrTx, async (tx) => {
    // Every count is taken before any statement runs: counting between removals
    // would report a child's rows against a parent whose earlier sibling edge
    // had already cleared them.
    const counts: CascadeCounts = {};
    for (const child of children) {
      if (child.auditKey === undefined) continue;
      // Per column, summed: a multi-column edge's count is "rows removed that
      // name this parent", so a row naming it from both ends is two removals'
      // worth of reference. Only reachable for a soft child — the two
      // multi-column edges in the schema are both hard and therefore uncounted.
      const perColumn: Record<string, number> = {};
      for (const column of child.parentColumns) {
        for (const [id, n] of Object.entries(
          await countByTarget(tx, child.table, column, ids),
        )) {
          perColumn[id] = (perColumn[id] ?? 0) + n;
        }
      }
      counts[child.auditKey] = perColumn;
    }

    // Before any removal: afterwards the association is gone and the ids with it.
    const cascadingImageIds = await collectCascadingImageIds(tx, children, ids);

    const now = new Date();
    for (const child of children) {
      const where = parentMatches(child.parentColumns, ids);
      if (child.mode === "hard") {
        await removeRows(tx, { table: child.table, where, mode: "hard" }, now);
      } else {
        await removeRows(tx, { table: child.table, where, mode: "soft" }, now);
      }
    }

    const table: ShortcodeTable = SHORTCODE_TABLE[entity];
    const where = inArray(table.id, [...ids]);
    if (removal === "hard") {
      await removeRows(tx, { table, where, mode: "hard" }, now);
    } else {
      await removeRows(tx, { table, where, mode: "soft" }, now);
    }

    await cascadeRemoval(tx, {
      entity,
      ids,
      counts: { ...counts, ...extraCounts },
      audit: { actor },
    });

    // After the cascade, so the audit entry above describes the association
    // removal rather than the file deletion that followed from it. Re-checks
    // every id against the full edge set, so an image another entity still
    // shows survives.
    const reaped = await reapUnreferencedImages(tx, cascadingImageIds);
    // `ids` is what was ACTUALLY removed, which is not always what the caller
    // asked for: `deleteTasks` passes `[...ids, ...liveSubtasks]`, so a request
    // to delete one parent task can remove several rows. Reporting the caller's
    // input length instead understates those cascades — see `deleteHandler`,
    // which had no measured count to report and asserted `ids.length`.
    return {
      detachedImageKeys: reaped.deletedKeys,
      deletedImageShortcodes: reaped.deletedShortcodes,
      deleted: ids.length,
    };
  });
};
