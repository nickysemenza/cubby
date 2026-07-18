/**
 * Full-replacement helper for self-referencing "blocked by" dependency edge
 * tables (`projectDependency`, `taskDependency`): both project/crud.ts and
 * task/crud.ts hand-rolled the same delete-then-insert replacement set before
 * this was extracted.
 */

import type { AppErrorReason } from "@cubby/shared";
import type { AnyColumn, InferInsertModel } from "drizzle-orm";
import { and, eq, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";
import type { DrizzleTransaction } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { notDeleted } from "./query";

/**
 * Replace the full `blockedByIds` edge set for one entity, inside the
 * caller's transaction:
 *
 *   1. Dedupe `newIds`.
 *   2. Reject a self-reference (`id` blocked by itself) — BAD_REQUEST.
 *   3. Verify every id is a live row in `opts.entityTable` — throws
 *      `opts.notFoundReason` listing the missing ids if not.
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
    /** Human label used in error messages, e.g. "Project" / "Task". */
    label: string;
    /** AppErrorReason thrown when an incoming id doesn't exist. */
    notFoundReason: AppErrorReason;
  },
  id: TId,
  newIds: TId[],
): Promise<void> {
  const deduped = uniq(newIds);

  if (deduped.includes(id)) {
    throw createAppError(
      "SELF_DEPENDENCY",
      `A ${opts.label.toLowerCase()} cannot be blocked by itself.`,
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
        opts.notFoundReason,
        `${opts.label}(s) not found: ${missing.join(", ")}`,
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
