import { type RunTargetEntityKind } from "@cubby/schemas/run-fields";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { runEvidence, runFactEvidence, runTarget } from "~/server/db/schema";
import { planSlotCollisions } from "~/server/repo/merge/collisions";

type FactEvidence = typeof runFactEvidence.$inferSelect;

/** Only exact proof identities fold; independent retained originals survive. */
const foldFactEvidence = async (
  tx: DrizzleTransaction,
  rows: FactEvidence[],
  isKeeper: (row: FactEvidence) => boolean,
  slotKey: (row: FactEvidence) => string,
  changes: Partial<Pick<FactEvidence, "targetId" | "entityId">>,
): Promise<void> => {
  const plan = planSlotCollisions({
    keeperRows: rows.filter(isKeeper),
    loserRows: rows.filter((row) => !isKeeper(row)),
    slotKey,
  });
  for (const { into, rows: absorbed } of plan.absorb) {
    const supported = absorbed.find((row) => row.support !== null);
    if (into.support === null && supported) {
      await tx
        .update(runFactEvidence)
        .set({
          support: supported.support,
          supportRetiredAt: null,
        })
        .where(eq(runFactEvidence.id, into.id));
    }
  }
  const duplicates = plan.absorb.flatMap(({ rows: absorbed }) =>
    absorbed.map((row) => row.id),
  );
  if (duplicates.length) {
    await tx
      .delete(runFactEvidence)
      .where(inArray(runFactEvidence.id, duplicates));
  }
  if (plan.repoint.length) {
    await tx
      .update(runFactEvidence)
      .set(changes)
      .where(
        inArray(
          runFactEvidence.id,
          plan.repoint.map((row) => row.id),
        ),
      );
  }
};

/**
 * Merge only colliding tasks of the same Run, entity kind, and frozen work key.
 * Move both original evidence and accepted proof references before deleting a
 * folded target; source work rosters remain separate even on the same subject.
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
      const facts = await tx
        .select()
        .from(runFactEvidence)
        .where(inArray(runFactEvidence.targetId, [existing.id, target.id]))
        .orderBy(asc(runFactEvidence.id))
        .for("update");
      await foldFactEvidence(
        tx,
        facts,
        (row) => row.targetId === existing.id,
        (row) =>
          JSON.stringify([
            row.evidenceId,
            row.entityKind,
            row.entityId,
            row.fieldPath,
            row.valueFingerprint,
          ]),
        { targetId: existing.id },
      );
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
