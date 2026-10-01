import type { DrizzleTransaction } from "~/server/db";
import { runEvidence, runTarget } from "~/server/db/schema";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Re-point every `RunTarget` of the merged-away entities at the survivor.
 *
 * A run can already target the survivor. Preserve that canonical target
 * (moving the loser's evidence onto it) and drop the colliding loser row
 * before re-pointing the rest: the unique `(runId, entityId)` index makes a
 * bulk update unsafe here.
 */
export const mergeRunTargets = async (
  tx: DrizzleTransaction,
  keepId: string,
  loserIds: readonly string[],
): Promise<void> => {
  const targetedRuns = await tx
    .select({ id: runTarget.id, runId: runTarget.runId })
    .from(runTarget)
    .where(inArray(runTarget.entityId, [...loserIds]));
  for (const target of targetedRuns) {
    const [existing] = await tx
      .select({ id: runTarget.id })
      .from(runTarget)
      .where(
        and(eq(runTarget.runId, target.runId), eq(runTarget.entityId, keepId)),
      )
      .limit(1);
    if (existing) {
      await tx
        .update(runEvidence)
        .set({ targetId: existing.id })
        .where(eq(runEvidence.targetId, target.id));
      await tx.delete(runTarget).where(eq(runTarget.id, target.id));
    } else {
      await tx
        .update(runTarget)
        .set({ entityId: keepId, updatedAt: new Date() })
        .where(eq(runTarget.id, target.id));
    }
  }
};
