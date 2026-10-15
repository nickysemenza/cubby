import { runEntityId } from "@cubby/schemas/identifiers";
import { runStatus } from "@cubby/schemas/run-fields";
import { MAX_AUTOMATIC_WORKFLOW_FAILURES } from "@cubby/schemas/workflow-runs";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import { guardAiEvaluation } from "~/server/ai/repo/ai-evaluation";
import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { aiEvaluation, run } from "~/server/db/schema";

export type RunRow = typeof run.$inferSelect;
export type AiEvaluationRow = typeof aiEvaluation.$inferSelect;
type RunUpdate = Partial<typeof run.$inferInsert>;

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

/** Writes one Workflow attempt's checkpoint; a newer attempt or a stopped Run keeps its own. */
export async function writeRunningAttemptProgress(
  db: Database,
  runId: RunRow["id"],
  attempt: number,
  set: RunUpdate,
) {
  await getDb(db)
    .update(run)
    .set(set)
    .where(
      and(
        eq(run.id, runId),
        eq(run.status, "running"),
        sql`COALESCE((${run.progress}->>'attempt')::integer, 0) = ${attempt}`,
      ),
    );
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
    attempts: number;
    error: string;
    nextAttemptAt: Date;
    minimumBudgetMicroUSD?: number;
  },
) {
  const { minimumBudgetMicroUSD, ...values } = set;
  await getDb(db)
    .update(aiEvaluation)
    .set({
      ...values,
      deadlineAt: null,
      ...(minimumBudgetMicroUSD === undefined
        ? {}
        : {
            snapshot: sql`jsonb_set(${aiEvaluation.snapshot}, '{minimumBudgetMicroUSD}', to_jsonb(${minimumBudgetMicroUSD}::bigint))`,
          }),
    })
    .where(
      and(
        eq(aiEvaluation.id, item.id),
        eq(aiEvaluation.attemptToken, item.attemptToken!),
        inArray(aiEvaluation.state, ["running", "result_ready"]),
      ),
    );
}

export async function pauseRunForExecutionAuthorization(
  db: Database,
  runId: RunRow["id"],
  message: string,
) {
  await getDb(db)
    .update(run)
    .set({
      status: "paused_auth",
      endedAt: null,
      failureCode: "execution_authorization_unavailable",
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
  const [stored] = await getDb(db)
    .update(aiEvaluation)
    .set({ state: "result_ready", result })
    .where(
      and(
        eq(aiEvaluation.id, item.id),
        eq(aiEvaluation.attemptToken, item.attemptToken!),
        eq(aiEvaluation.state, "running"),
      ),
    )
    .returning({ id: aiEvaluation.id });
  return Boolean(stored);
}

/** Manual AI work whose dispatch may have been lost, within the automatic retry budget. */
export async function recoverableManualAiWorkRuns(
  db: Database,
  runIds?: readonly string[],
) {
  return getDb(db)
    .select()
    .from(run)
    .where(
      and(
        inArray(run.purpose, ["mail_reclassify", "suggestion_sweep"]),
        notDeleted(run),
        sql`${run.failureCode} IS DISTINCT FROM 'user_cancelled'`,
        sql`(${run.status} NOT IN (${runStatus.enum.failed}, ${runStatus.enum.dispatch_failed}) OR coalesce((${run.progress}->>'automaticRecoveryFailures')::int, 0) < ${MAX_AUTOMATIC_WORKFLOW_FAILURES})`,
        runIds
          ? inArray(
              run.id,
              runIds.map((id) => runEntityId.parse(id)),
            )
          : undefined,
        or(
          eq(run.status, "failed"),
          eq(run.status, "dispatch_failed"),
          eq(run.status, "paused_auth"),
          eq(run.status, "running"),
        ),
      ),
    );
}

/** Completes a recovered Run unless its status, attempt, or a member cancellation moved on. */
export async function completeRecoveredAiWorkRun(
  db: Database,
  owner: Pick<RunRow, "id" | "status">,
  attempt: number,
  progress: RunRow["progress"],
) {
  await getDb(db)
    .update(run)
    .set({
      status: "completed",
      endedAt: new Date(),
      failureCode: null,
      dispatchError: null,
      progress,
    })
    .where(
      and(
        eq(run.id, owner.id),
        eq(run.status, owner.status),
        sql`COALESCE((${run.progress}->>'attempt')::integer, 0) = ${attempt}`,
        sql`${run.failureCode} IS DISTINCT FROM 'user_cancelled'`,
      ),
    );
}
