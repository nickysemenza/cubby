import { and, eq, inArray, lt, notExists, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import { guardAiEvaluation } from "~/server/ai/repo/ai-evaluation";
import { PENDING_AI_STATES } from "~/server/ai/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { aiEvaluation, run } from "~/server/db/schema";
import {
  currentJobExecution,
  assertCurrentJob,
} from "~/server/generic/jobs/repo/execution";

export type RunRow = typeof run.$inferSelect;
export type AiEvaluationRow = typeof aiEvaluation.$inferSelect & {
  attemptToken?: string | null;
};
type RunUpdate = PgUpdateSetSource<typeof run>;

export async function readRun(
  db: Database,
  runId: RunRow["id"],
  { live = false }: { live?: boolean } = {},
): Promise<RunRow | undefined> {
  const [row] = await getDb(db)
    .select()
    .from(run)
    .where(and(eq(run.id, runId), live ? notDeleted(run) : undefined));
  return row;
}

export async function readRunStatus(db: Database, runId: RunRow["id"]) {
  const [row] = await getDb(db)
    .select({ status: run.status })
    .from(run)
    .where(eq(run.id, runId));
  return row?.status;
}

/** Writes a checkpoint only for its current Job generation and live token. */
export async function writeRunningAttemptProgress(
  db: Database,
  runId: RunRow["id"],
  attempt: number,
  set: RunUpdate,
  options: { requireNoOwnedPendingWork?: boolean } = {},
) {
  const execution = currentJobExecution();
  if (
    !execution ||
    execution.claim.kind !== "run.execute" ||
    execution.claim.key !== `run:${runId}` ||
    execution.claim.generation !== attempt
  )
    throw new Error("Run checkpoint requires its current universal Job claim");
  const write = async (target: Database) => {
    const written = await getDb(target)
      .update(run)
      .set(set)
      .where(
        and(
          eq(run.id, runId),
          eq(run.status, "running"),
          // Discovery may add or reopen work after the attempt read its roster.
          options.requireNoOwnedPendingWork
            ? notExists(
                getDb(target)
                  .select({ id: aiEvaluation.id })
                  .from(aiEvaluation)
                  .where(
                    and(
                      eq(aiEvaluation.runId, run.id),
                      inArray(aiEvaluation.state, [...PENDING_AI_STATES]),
                      sql`${aiEvaluation.receipt}->>'retryEvaluationId' IS NULL`,
                    ),
                  ),
              )
            : undefined,
        ),
      )
      .returning({ id: run.id, shortcode: run.shortcode });
    if (written[0])
      await (
        await import("./work-progress")
      ).checkpointRunWorkProgress(target, written[0].shortcode);
    return written.length > 0;
  };
  return withTransactionDatabase(db, async (tx) => {
    await assertCurrentJob(tx);
    // Under READ COMMITTED an UPDATE that waits on the Run row rechecks only that
    // row, not its NOT EXISTS subquery. Taking the lock first gives the guarded
    // UPDATE a fresh snapshot that sees work discovery committed under the lock.
    await getDb(tx)
      .select({ id: run.id })
      .from(run)
      .where(eq(run.id, runId))
      .for("no key update");
    return write(tx);
  });
}

export async function aiEvaluationsForRun(db: Database, runId: RunRow["id"]) {
  return getDb(db)
    .select()
    .from(aiEvaluation)
    .where(eq(aiEvaluation.runId, runId));
}

export async function readAiEvaluation(
  db: Database,
  id: string,
): Promise<AiEvaluationRow | undefined> {
  const [row] = await getDb(db)
    .select()
    .from(aiEvaluation)
    .where(eq(aiEvaluation.id, id));
  return row;
}

export async function guardAiEvaluationAttempt(
  db: Database,
  id: string,
  attemptToken: string,
) {
  await withTransactionDatabase(db, (tx) =>
    guardAiEvaluation(tx, id, attemptToken),
  );
}

/** Settles a failed attempt only while that attempt still owns the evaluation. */
export async function recordAiEvaluationAttemptFailure(
  db: Database,
  item: Pick<AiEvaluationRow, "id" | "attemptToken">,
  set: {
    state: AiEvaluationRow["state"];
    error: string;
  },
) {
  const execution = currentJobExecution();
  if (
    !execution ||
    execution.claim.kind !== "ai.evaluation" ||
    execution.claim.key !== `ai-evaluation:${item.id}` ||
    execution.claim.leaseToken !== item.attemptToken
  )
    throw new Error(
      "AI evaluation failure requires its current universal Job claim",
    );
  await withTransactionDatabase(db, async (tx) => {
    // A funding/auth stop may have paused the requester after inference.
    // Only execution ownership fences this diagnostic; publication still
    // checks the requester's current domain authority separately.
    await assertCurrentJob(tx);
    await getDb(tx)
      .update(aiEvaluation)
      .set({ state: set.state, error: set.error })
      .where(
        and(
          eq(aiEvaluation.id, item.id),
          inArray(aiEvaluation.state, ["running", "result_ready"]),
        ),
      );
  });
}

/** Mail discovery a funding stop paused before `pausedBefore`. */
export async function fundingPausedDiscoveryRuns(
  db: Database,
  pausedBefore: Date,
) {
  const rows = await getDb(db)
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.purpose, "mail_discovery"),
        eq(run.status, "paused_auth"),
        eq(run.failureCode, "execution_limit"),
        lt(run.updatedAt, pausedBefore),
        notDeleted(run),
      ),
    );
  return rows.map((row) => row.id);
}

/** Waits for the next budget window or a reconnected mailbox; recovery resumes it. */
export async function pauseRunForAiWork(
  db: Database,
  runId: RunRow["id"],
  message: string,
) {
  await getDb(db)
    .update(run)
    .set({
      status: "paused_auth",
      endedAt: null,
      failureCode: "execution_limit",
      dispatchError: message,
    })
    .where(
      and(
        eq(run.id, runId),
        or(
          eq(run.status, "running"),
          and(
            eq(run.status, "needs_review"),
            eq(run.failureCode, "execution_limit"),
          ),
        ),
      ),
    );
  await (
    await import("~/server/workflows/runs/wake")
  ).wakeStepRunParent(db, runId);
}

export async function readAiEvaluationReceipt(db: Database, id: string) {
  const [row] = await getDb(db)
    .select({ receipt: aiEvaluation.receipt })
    .from(aiEvaluation)
    .where(eq(aiEvaluation.id, id));
  return row?.receipt;
}

/** Stores an inference result while the attempt still owns the running evaluation; false when obsolete. */
export async function storeAiEvaluationResult(
  db: Database,
  item: Pick<AiEvaluationRow, "id" | "attemptToken">,
  result: AiEvaluationRow["result"],
) {
  if (!item.attemptToken)
    throw new Error("AI result has no universal Job token");
  return withTransactionDatabase(db, async (tx) => {
    await guardAiEvaluationAttempt(tx, item.id, item.attemptToken!);
    const [stored] = await getDb(tx)
      .update(aiEvaluation)
      .set({ state: "result_ready", result })
      .where(
        and(eq(aiEvaluation.id, item.id), eq(aiEvaluation.state, "running")),
      )
      .returning({ id: aiEvaluation.id });
    return Boolean(stored);
  });
}
