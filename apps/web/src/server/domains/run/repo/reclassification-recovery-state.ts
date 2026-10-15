import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { aiEvaluation, email, run, runOperation } from "~/server/db/schema";

const RECLASSIFICATION_RECOVERY_OPERATION = "reclassification-recovery-v1";

export type RecoveryCursor = Pick<typeof run.$inferSelect, "createdAt" | "id">;
export type RecoverySourceRun = typeof run.$inferSelect;
export type RecoveryEmail = typeof email.$inferSelect;

const relevanceReclassify = () =>
  sql`${run.input}->>${mailReclassifyRunInput.keyof().enum.kind} = ${mailReclassifyRunInput.shape.kind.value} AND ${run.input}->>${mailReclassifyRunInput.keyof().enum.mode} = ${mailReclassifyRunInput.shape.mode.enum.relevance}`;

/** Ended relevance reclassify Runs with no evaluation roster and no recorded recovery, in creation order. */
export async function unrecoveredReclassificationRuns(
  db: Database,
  cursor: RecoveryCursor | undefined,
  limit: number,
) {
  return getDb(db)
    .select()
    .from(run)
    .where(
      and(
        relevanceReclassify(),
        or(
          inArray(run.status, ["completed", "failed"]),
          and(
            eq(run.status, "needs_review"),
            eq(run.failureCode, "execution_limit"),
          ),
        ),
        notDeleted(run),
        sql`${run.failureCode} IS DISTINCT FROM 'user_cancelled'`,
        cursor
          ? sql`(${run.createdAt}, ${run.id}) > (${cursor.createdAt}, ${cursor.id}::uuid)`
          : undefined,
        sql`NOT EXISTS (SELECT 1 FROM "AiEvaluationRequest" AS request WHERE request."runId" = "Run".id)`,
        sql`NOT EXISTS (SELECT 1 FROM "RunOperation" AS recovered WHERE recovered."runId" = "Run".id AND recovered."operationId" = ${RECLASSIFICATION_RECOVERY_OPERATION})`,
      ),
    )
    .orderBy(run.createdAt, run.id)
    .limit(limit);
}

export async function liveEmailsById(
  db: Database,
  ids: readonly RecoveryEmail["id"][],
) {
  return getDb(db)
    .select()
    .from(email)
    .where(and(inArray(email.id, [...ids]), notDeleted(email)));
}

/** A settled reclassify evaluation for this Email's current checksum, newer than `after`. */
export async function hasLaterReclassifyEvaluation(
  db: Database,
  item: Pick<RecoveryEmail, "id" | "checksum">,
  after: Date,
) {
  const [later] = await getDb(db)
    .select({ receipt: aiEvaluation.receipt })
    .from(aiEvaluation)
    .where(
      and(
        eq(aiEvaluation.executionKind, "mail_reclassify"),
        sql`${aiEvaluation.target}->>'recordId' = ${item.id}`,
        gt(aiEvaluation.createdAt, after),
        inArray(aiEvaluation.state, ["completed", "blocked"]),
        sql`${aiEvaluation.receipt}->>'sourceChecksum' = ${item.checksum}`,
      ),
    )
    .limit(1);
  return Boolean(later);
}

/** Completed legacy relevance reclassify Runs for one party, newest first. */
export async function laterLegacyReclassifyRuns(
  db: Database,
  ledgerPartyId: RecoveryEmail["ledgerPartyId"],
  after: Date,
) {
  return getDb(db)
    .select({ input: run.input, progress: run.progress })
    .from(run)
    .where(
      and(
        gt(run.createdAt, after),
        eq(run.status, "completed"),
        eq(run.ledgerPartyId, ledgerPartyId),
        relevanceReclassify(),
      ),
    )
    .orderBy(desc(run.createdAt));
}

/** Locks the source Run; true when its recovery is already recorded. */
export async function lockRunAndCheckRecovery(
  tx: Database,
  runId: RecoverySourceRun["id"],
) {
  await getDb(tx)
    .select({ id: run.id })
    .from(run)
    .where(eq(run.id, runId))
    .for("update");
  const [recorded] = await getDb(tx)
    .select({ id: runOperation.id })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, runId),
        eq(runOperation.operationId, RECLASSIFICATION_RECOVERY_OPERATION),
      ),
    );
  return Boolean(recorded);
}

export async function recordReclassificationRecovery(
  tx: Database,
  runId: RecoverySourceRun["id"],
  inputFingerprint: string,
  result: unknown,
) {
  await getDb(tx)
    .insert(runOperation)
    .values({
      runId,
      operationId: RECLASSIFICATION_RECOVERY_OPERATION,
      kind: "reclassification_recovery",
      inputFingerprint,
      state: "completed",
      completedAt: new Date(),
      result: z.json().parse(result),
    });
}
