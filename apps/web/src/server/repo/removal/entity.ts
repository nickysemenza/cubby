/**
 * The front door `cascadeRemoval` is the tail of: remove an entity's own rows,
 * its declared child rows, and everything derived from them, in one call.
 *
 * ## Why this is a separate function rather than more of `cascadeRemoval`
 *
 * `cascadeRemoval` deliberately never touches the entity's own table, because
 * a handful of paths depend on *when* the row dies relative to something else
 * (`product/merge.ts` must vacate a partial UPC index before the keeper adopts
 * it; `inventory/bulk.ts` hard-deletes emptied sources up front to free slot
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
 *  - **Blocking guards.** Five mutually incompatible shapes across the repo,
 *    and the error message — which ids blocked, and with how many dependents —
 *    *is* the product. A generic guard could only make it worse.
 *  - **Rich return values and in-transaction side effects.**
 *    `deleteExpensesWithPurchaseEffects` computes newly-empty purchases from
 *    post-delete queries; several sites call `touchDataQualityTargets` or
 *    `syncChangedEffectivePrices`. Those run in the caller's own transaction,
 *    which `withTransactionOn` guarantees this call joins.
 *  - **Staleness dispatch.** Zero of the removal paths do it here; it is the
 *    router's job, via `runMutationSideEffects`.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { BrandForEntity } from "@cubby/schemas/identifiers";
import { and, inArray, or, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, withTransactionOn } from "~/server/repo/database-helpers";
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
  return or(match(first), ...rest.map(match)) as SQL<unknown>;
};

/**
 * Issue one removal statement. Soft removal re-applies `notDeleted` so a row
 * already dead keeps its original `deletedAt` rather than having the timestamp
 * rewritten by a second delete.
 */
const removeRows = async (
  tx: DrizzleTransaction,
  table: PgTable,
  where: SQL,
  mode: "soft" | "hard",
  at: Date,
): Promise<void> => {
  if (mode === "hard") {
    await tx.delete(table).where(where);
    return;
  }
  const deletedAt = (table as SoftDeletableTable).deletedAt;
  await tx
    .update(table)
    .set({ deletedAt: at })
    .where(and(where, notDeleted({ deletedAt })));
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
 */
export const removeEntity = async <E extends RemovableEntity>(
  dbOrTx: Database | DrizzleTransaction,
  args: {
    entity: E;
    ids: readonly BrandForEntity<E>[];
    removal: "soft" | "hard";
    actor: ActorContext;
    children?: readonly ChildCascade[];
    /** Counts the caller computed itself, merged over the derived ones. */
    extraCounts?: CascadeCounts;
  },
): Promise<void> => {
  const { entity, ids, removal, actor, children = [], extraCounts } = args;
  if (ids.length === 0) return;

  await withTransactionOn(dbOrTx, async (tx) => {
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

    const now = new Date();
    for (const child of children) {
      await removeRows(
        tx,
        child.table,
        parentMatches(child.parentColumns, ids),
        child.mode ?? "soft",
        now,
      );
    }

    const table = SHORTCODE_TABLE[entity] as ShortcodeTable;
    await removeRows(tx, table, inArray(table.id, [...ids]), removal, now);

    await cascadeRemoval(tx, {
      entity,
      ids,
      counts: { ...counts, ...extraCounts },
      audit: { actor },
    });
  });
};
