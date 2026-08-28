/**
 * Full-replacement helper for self-referencing "blocked by" dependency edge
 * tables (`projectDependency`, `taskDependency`): both project/crud.ts and
 * task/crud.ts hand-rolled the same delete-then-insert replacement set before
 * this was extracted.
 */

import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  ENTITY_LABEL,
  ENTITY_NOT_FOUND_REASON,
  type EntityId,
  parseEntityId,
} from "@cubby/schemas/identifiers";
import type { AnyColumn, InferInsertModel } from "drizzle-orm";
import { and, eq, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";

import { getDb } from "./core";
import { notDeleted } from "./query";

/**
 * Replace the full `blockedByIds` edge set for one entity, inside the
 * caller's transaction:
 *
 *   1. Dedupe `newIds`.
 *   2. Reject a self-reference (`id` blocked by itself) — BAD_REQUEST.
 *   3. Verify every id is a live row in `opts.entityTable` — throws
 *      `ENTITY_NOT_FOUND_REASON[opts.entity]` listing the missing ids if not.
 *   4. Delete `id`'s existing edges, then insert the (deduped) new set.
 */
export async function replaceDependencyEdges<
  TEdge extends PgTable,
  E extends ShortcodeEntity,
>(
  tx: DrizzleTransaction,
  edgeTable: TEdge,
  opts: {
    /** Column on `edgeTable` identifying the "owning" side (`id`'s row). */
    ownColumn: AnyColumn;
    /** Column on `edgeTable` identifying the "blocked-by" side (`newIds`). */
    blockedByColumn: AnyColumn;
    /** Build one edge row to insert from (ownId, blockedById). */
    buildRow: (
      ownId: EntityId<E>,
      blockedById: EntityId<E>,
    ) => InferInsertModel<TEdge>;
    /** Table the incoming ids must exist (live) in. */
    entityTable: PgTable & { id: AnyColumn; deletedAt: AnyColumn };
    /**
     * Drives both the error label (`ENTITY_LABEL[entity]`) and the
     * AppErrorReason (`ENTITY_NOT_FOUND_REASON[entity]`) thrown when an
     * incoming id doesn't exist, so the pair can't drift out of sync.
     */
    entity: E;
  },
  id: EntityId<E>,
  newIds: EntityId<E>[],
): Promise<void> {
  const deduped = uniq(newIds);
  const label = ENTITY_LABEL[opts.entity];
  const lowerLabel = label.toLowerCase();
  // Every current `ENTITY_LABEL` value starts with either a consonant sound
  // or a true vowel sound (no silent-h / "u"-as-"you" cases), so a plain
  // first-letter check picks the right article for all of them.
  const article = /^[aeiou]/iu.test(lowerLabel) ? "An" : "A";

  if (deduped.includes(id)) {
    throw createAppError(
      "SELF_DEPENDENCY",
      `${article} ${lowerLabel} cannot be blocked by itself.`,
    );
  }

  if (deduped.length > 0) {
    const live = await tx
      // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle's dynamic column type is too narrow for select().
      .select({ id: opts.entityTable.id as any })
      .from(opts.entityTable)
      .where(
        and(
          // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle's dynamic column type is too narrow for inArray().
          inArray(opts.entityTable.id as any, deduped),
          notDeleted(opts.entityTable),
        ),
      );
    const liveIds = new Set(
      live.map((row) => parseEntityId(opts.entity, row.id)),
    );
    const missing = deduped.filter((depId) => !liveIds.has(depId));
    if (missing.length > 0) {
      throw createAppError(
        ENTITY_NOT_FOUND_REASON[opts.entity],
        `${label}(s) not found: ${missing.join(", ")}`,
      );
    }
  }

  await tx.delete(edgeTable).where(eq(opts.ownColumn, id));
  if (deduped.length > 0) {
    await tx
      .insert(edgeTable)
      .values(deduped.map((blockedById) => opts.buildRow(id, blockedById)));
  }
}

/**
 * Read-side twin of {@link replaceDependencyEdges}: batched blocked-by /
 * blocking id lookups for a set of entities sharing one self-referencing edge
 * table, one query per direction (never one query per entity). Mirrors the
 * same generic-typing style (`TEdge extends PgTable`, `AnyColumn` params, the
 * same lint-suppressed cast pattern for Drizzle's narrow `AnyColumn` typing)
 * — takes a plain `Database` (not a transaction), since both call sites are
 * read paths.
 *
 * `edgeTable` rows are directed: `ownColumn` is blocked by `blockedByColumn`.
 * "blocking" is the reverse read of the same rows — which entities does THIS
 * entity block.
 */
export async function dependencyIdsFor<
  TEdge extends PgTable,
  E extends ShortcodeEntity,
>(
  db: Database,
  edgeTable: TEdge,
  opts: {
    /** Column on `edgeTable` identifying the "owning" side (`ids`' rows). */
    ownColumn: AnyColumn;
    /** Column on `edgeTable` identifying the "blocked-by" side. */
    blockedByColumn: AnyColumn;
    /** Entity schema used to validate the raw projection at this repo seam. */
    entity: E;
  },
  ids: EntityId<E>[],
): Promise<{
  blockedBy: Map<EntityId<E>, EntityId<E>[]>;
  blocking: Map<EntityId<E>, EntityId<E>[]>;
}> {
  const blockedBy = new Map<EntityId<E>, EntityId<E>[]>();
  const blocking = new Map<EntityId<E>, EntityId<E>[]>();
  if (ids.length === 0) return { blockedBy, blocking };

  const selectCols = {
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle's dynamic column type is too narrow for select().
    own: opts.ownColumn as any,
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle's dynamic column type is too narrow for select().
    blockedBy: opts.blockedByColumn as any,
  };

  const [blockedByRows, blockingRows] = await Promise.all([
    getDb(db)
      .select(selectCols)
      // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle's generic edge table is too narrow for from().
      .from(edgeTable as any)
      // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle's dynamic column type is too narrow for inArray().
      .where(inArray(opts.ownColumn as any, ids)),
    getDb(db)
      .select(selectCols)
      // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle's generic edge table is too narrow for from().
      .from(edgeTable as any)
      // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle's dynamic column type is too narrow for inArray().
      .where(inArray(opts.blockedByColumn as any, ids)),
  ]);

  for (const row of blockedByRows) {
    const own = parseEntityId(opts.entity, row.own);
    const blockedById = parseEntityId(opts.entity, row.blockedBy);
    const arr = blockedBy.get(own) ?? [];
    arr.push(blockedById);
    blockedBy.set(own, arr);
  }
  for (const row of blockingRows) {
    const own = parseEntityId(opts.entity, row.own);
    const blockedById = parseEntityId(opts.entity, row.blockedBy);
    const arr = blocking.get(blockedById) ?? [];
    arr.push(own);
    blocking.set(blockedById, arr);
  }
  return { blockedBy, blocking };
}
