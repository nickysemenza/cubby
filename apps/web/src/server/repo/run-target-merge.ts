import { type RunTargetEntityKind } from "@cubby/schemas/run-fields";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { runTarget } from "~/server/db/schema";

/**
 * Merge only colliding tasks of the same Run, entity kind, and frozen work key:
 * the loser's colliding target is deleted, the rest move to the keeper. Source
 * work rosters remain separate even on the same subject.
 */
export const mergeRunTargets = async (
  tx: DrizzleTransaction,
  entityKind: RunTargetEntityKind,
  keepId: string,
  loserIds: readonly string[],
): Promise<void> => {
  const targetedRuns = await tx
    .select()
    .from(runTarget)
    .where(
      and(
        eq(runTarget.entityKind, entityKind),
        inArray(runTarget.entityId, [...loserIds]),
      ),
    )
    .orderBy(asc(runTarget.id))
    .for("update");
  for (const target of targetedRuns) {
    const [existing] = await tx
      .select({ id: runTarget.id })
      .from(runTarget)
      .where(
        and(
          eq(runTarget.runId, target.runId),
          eq(runTarget.entityKind, entityKind),
          eq(runTarget.entityId, keepId),
          eq(runTarget.workKey, target.workKey),
        ),
      )
      .for("update");
    if (existing) {
      await tx.delete(runTarget).where(eq(runTarget.id, target.id));
    } else {
      await tx
        .update(runTarget)
        .set({ entityId: keepId, updatedAt: new Date() })
        .where(eq(runTarget.id, target.id));
    }
  }
};
