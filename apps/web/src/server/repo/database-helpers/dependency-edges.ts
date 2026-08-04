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
  TId extends string,
>(
  tx: DrizzleTransaction,
  edgeTable: TEdge,
  opts: {
    /** Column on `edgeTable` identifying the "owning" side (`id`'s row). */
    ownColumn: AnyColumn;
    /** Column on `edgeTable` identifying the "blocked-by" side (`newIds`). */
    blockedByColumn: AnyColumn;
    /** Build one edge row to insert from (ownId, blockedById). */
    buildRow: (ownId: TId, blockedById: TId) => InferInsertModel<TEdge>;
    /** Table the incoming ids must exist (live) in. */
    entityTable: PgTable & { id: AnyColumn; deletedAt: AnyColumn };
    /**
     * Drives both the error label (`ENTITY_LABEL[entity]`) and the
     * AppErrorReason (`ENTITY_NOT_FOUND_REASON[entity]`) thrown when an
     * incoming id doesn't exist, so the pair can't drift out of sync.
     */
    entity: ShortcodeEntity;
  },
  id: TId,
  newIds: TId[],
): Promise<void> {
  const deduped = uniq(newIds);
  const label = ENTITY_LABEL[opts.entity];

  if (deduped.includes(id)) {
    throw createAppError(
      "SELF_DEPENDENCY",
      `A ${label.toLowerCase()} cannot be blocked by itself.`,
    );
  }

  if (deduped.length > 0) {
    const live = await tx
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for select()
      .select({ id: opts.entityTable.id as any })
      .from(opts.entityTable)
      .where(
        and(
          // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for inArray()
          inArray(opts.entityTable.id as any, deduped),
          notDeleted(opts.entityTable),
        ),
      );
    const liveIds = new Set((live as Array<{ id: TId }>).map((row) => row.id));
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
  TId extends string,
>(
  db: Database,
  edgeTable: TEdge,
  opts: {
    /** Column on `edgeTable` identifying the "owning" side (`ids`' rows). */
    ownColumn: AnyColumn;
    /** Column on `edgeTable` identifying the "blocked-by" side. */
    blockedByColumn: AnyColumn;
  },
  ids: TId[],
): Promise<{
  blockedBy: Map<TId, TId[]>;
  blocking: Map<TId, TId[]>;
}> {
  const blockedBy = new Map<TId, TId[]>();
  const blocking = new Map<TId, TId[]>();
  if (ids.length === 0) return { blockedBy, blocking };

  const selectCols = {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for select()
    own: opts.ownColumn as any,
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for select()
    blockedBy: opts.blockedByColumn as any,
  };

  const [blockedByRows, blockingRows] = await Promise.all([
    getDb(db)
      .select(selectCols)
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle's generic TEdge is too narrow for from()
      .from(edgeTable as any)
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for inArray()
      .where(inArray(opts.ownColumn as any, ids)),
    getDb(db)
      .select(selectCols)
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle's generic TEdge is too narrow for from()
      .from(edgeTable as any)
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for inArray()
      .where(inArray(opts.blockedByColumn as any, ids)),
  ]);

  for (const row of blockedByRows as Array<{ own: TId; blockedBy: TId }>) {
    const arr = blockedBy.get(row.own) ?? [];
    arr.push(row.blockedBy);
    blockedBy.set(row.own, arr);
  }
  for (const row of blockingRows as Array<{ own: TId; blockedBy: TId }>) {
    const arr = blocking.get(row.blockedBy) ?? [];
    arr.push(row.own);
    blocking.set(row.blockedBy, arr);
  }
  return { blockedBy, blocking };
}
