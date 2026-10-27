import { aiEvaluationState } from "@cubby/schemas/ai-evaluation";
import type { ActorContext } from "@cubby/schemas/context";
import { runShortcode, type RunId } from "@cubby/schemas/identifiers";
import {
  OWNED_AI_WORK_PURPOSES,
  type RunControlAction,
} from "@cubby/schemas/run-fields";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { ledgerParty, run as runTable } from "~/server/db/schema";
import { systemActor } from "~/server/domains/run/repo/ensure-run";
import { recordPaidGrant } from "~/server/domains/run/repo/paid-grant";
import { createAppError } from "~/server/errors/app-error";
import {
  cancelJobsWhere,
  cancelRunJobs,
  pauseJob,
} from "~/server/generic/jobs/repo/operator";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";

import type { ExecutedRunPurpose } from "./contract";
import { launchWorkflowRun, recordRunProgress } from "./lifecycle";

/** Kinds whose evaluations name the Run as owner; a Sweep owns its connection evaluations. */
const ownsAiWork = (purpose: ExecutedRunPurpose) =>
  OWNED_AI_WORK_PURPOSES.some((owned) => owned === purpose) ||
  purpose === "sweep";
/** Kinds that request shared evaluations; discovery's requests outlive a cancel. */
const requestsAiWork = (purpose: ExecutedRunPurpose) =>
  purpose !== "mail_discovery" &&
  !OWNED_AI_WORK_PURPOSES.some((owned) => owned === purpose);

/**
 * `run.control` stops or retries the Run's universal Job and its child demand.
 * Domain progress and receipts survive an explicit retry.
 * Only the member whose mailbox or search it is may control it.
 */
export async function controlWorkflowRun(
  db: Database,
  actor: ActorContext,
  input: {
    runPublicId: string;
    action: RunControlAction;
    paidOverBudgetUsd?: number;
  },
  purpose: ExecutedRunPurpose,
): Promise<void> {
  const database = getDb(db);
  const [row] = await database
    .select({
      id: runTable.id,
      shortcode: runTable.shortcode,
      status: runTable.status,
      failureCode: runTable.failureCode,
      actorUserId: runTable.actorUserId,
      memberUserId: ledgerParty.userId,
      attempt: sql<number>`coalesce((${runTable.progress}->>'attempt')::int, 0)`,
    })
    .from(runTable)
    .leftJoin(ledgerParty, eq(ledgerParty.id, runTable.ledgerPartyId))
    .where(eq(runTable.shortcode, runShortcode.parse(input.runPublicId)))
    .limit(1);
  if (!row) throw createAppError("RUN_NOT_FOUND", "Run was not found");
  if (
    // Unattended work (AI refresh, nightly maintenance, routine Sweeps and
    // their children) belongs to the household, so any member may control it.
    row.actorUserId !== systemActor().userId &&
    row.actorUserId !== actor.userId &&
    row.memberUserId !== actor.userId
  )
    throw new Error("Only the member this Run belongs to can control it");
  if (input.action === "pause") {
    if (
      !["mail_reclassify", "suggestion_sweep"].includes(purpose) ||
      row.status !== "running"
    )
      throw createAppError(
        "RUN_CONTROL_REFUSED",
        "Only running member-requested AI work can be paused",
      );
    await withTransactionDatabase(db, async (tx) => {
      await getDb(tx)
        .update(runTable)
        .set({ status: "paused" })
        .where(eq(runTable.id, row.id));
      const [execution] = await getDb(tx)
        .select({ id: job.id })
        .from(job)
        .where(eq(job.key, `run:${row.id}`));
      if (execution) await pauseJob(tx, execution.id);
    });
    return;
  }
  if (input.action === "run_now_paid") {
    // Every background frontier Workflow shares funding admission. Discovery
    // grants also cover its child imports; unrelated auth pauses stay blocked.
    if (row.status !== "paused_auth" || row.failureCode !== "execution_limit")
      throw createAppError(
        "RUN_CONTROL_REFUSED",
        `Only a funding-paused Run can run now with paid models (${purpose}, ${row.status}, ${row.failureCode})`,
      );
    await recordPaidGrant(db, actor, {
      runId: row.id,
      paidOverBudgetUsd: input.paidOverBudgetUsd,
    });
    await launchWorkflowRun(db, { runId: row.id, purpose });
    return;
  }
  if (input.action === "resume") {
    if (!["paused", "paused_auth"].includes(row.status))
      throw createAppError(
        "RUN_CONTROL_REFUSED",
        "Only paused AI work can be resumed",
      );
    await launchWorkflowRun(db, { runId: row.id, purpose });
    return;
  }
  if (input.action === "retry") {
    if (row.status !== "failed")
      throw createAppError(
        "RUN_CONTROL_REFUSED",
        `Only a failed Run can be retried (${row.status})`,
      );
    if (purpose === "mail_reclassify") {
      const { requestedAiEvaluations } =
        await import("~/server/ai/repo/ai-evaluation-requests");
      if (
        !(await requestedAiEvaluations(db, row.id, { currentOnly: true }))
          .length
      )
        throw createAppError(
          "RUN_CONTROL_REFUSED",
          "This legacy Run retains historical receipts; historical recovery creates a linked continuation rather than retrying its empty roster.",
        );
    }
    if (ownsAiWork(purpose) || requestsAiWork(purpose))
      await readmitFailedAiWork(db, row.id, {
        owned: ownsAiWork(purpose),
        requested: requestsAiWork(purpose),
        attempt: row.attempt,
      });
    await launchWorkflowRun(db, { runId: row.id, purpose });
    return;
  }
  if (input.action !== "cancel")
    throw createAppError(
      "RUN_CONTROL_UNSUPPORTED",
      `A ${purpose} Run supports cancel and retry only`,
    );
  if (!["running", "paused", "paused_auth"].includes(row.status))
    throw createAppError(
      "RUN_CONTROL_REFUSED",
      `Only active work can be cancelled (${row.status})`,
    );
  await withTransactionDatabase(db, async (tx) => {
    const database = getDb(tx);
    await database.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('cubby-ai-admission'))`,
    );
    const [cancelled] = await database
      .update(runTable)
      .set({
        status: "failed",
        endedAt: new Date(),
        failureCode: "user_cancelled",
        dispatchError: "Cancelled by a member",
        progress: sql`coalesce(${runTable.progress}, '{}'::jsonb) || '{"phase":"failed"}'::jsonb`,
      })
      .where(
        and(
          eq(runTable.id, row.id),
          inArray(runTable.status, ["running", "paused", "paused_auth"]),
        ),
      )
      .returning({ id: runTable.id });
    if (!cancelled)
      throw createAppError(
        "RUN_CONTROL_REFUSED",
        "The Run finished before it was cancelled",
      );
    await cancelRunJobs(tx, row.id);
    return cancelRunAiWork(tx, row.id, "Cancelled by a member", {
      owned: ownsAiWork(purpose),
      requested: requestsAiWork(purpose),
    });
  });
  await recordRunProgress(db, row.id, "cancelled", "Cancelled by a member", {
    attempt: row.attempt,
    sequence: Number.MAX_SAFE_INTEGER,
  });
}

/**
 * Stops a Run's pending AI work: evaluations it owns become cancelled and
 * its requests on shared evaluations are withdrawn; their Jobs stop.
 * Returns whether another requester still shares cancelled demand.
 */
export async function cancelRunAiWork(
  db: Database,
  runId: RunId,
  reason: string,
  scope: { owned: boolean; requested: boolean } = {
    owned: true,
    requested: true,
  },
) {
  return withTransactionDatabase(db, async (tx) => {
    const database = getDb(tx);
    if (scope.owned) {
      const { aiEvaluation } = await import("~/server/db/schema");
      await database
        .update(aiEvaluation)
        .set({ state: "cancelled", error: reason, updatedAt: new Date() })
        .where(
          and(
            eq(aiEvaluation.runId, runId),
            inArray(aiEvaluation.state, [
              "queued",
              "running",
              "result_ready",
              "retry_wait",
            ]),
          ),
        );
    }
    let sharedDemand = false;
    if (scope.requested) {
      const { cancelAiEvaluationRequests } =
        await import("~/server/ai/repo/ai-evaluation-requests");
      sharedDemand = await cancelAiEvaluationRequests(tx, runId);
    }
    // One statement: a per-Job loop under the caller's admission lock timed
    // out for Runs owning tens of thousands of evaluations.
    await cancelJobsWhere(
      tx,
      sql`${job.key} IN (SELECT 'ai-evaluation:' || e.id::text FROM "AiEvaluation" e
        WHERE e.state=${aiEvaluationState.enum.cancelled} AND (e."runId"=${runId}::uuid
          OR EXISTS (SELECT 1 FROM "AiEvaluationRequest" r WHERE r."evaluationId"=e.id AND r."runId"=${runId}::uuid)))`,
    );
    return sharedDemand;
  });
}

/**
 * Re-admits a Run's failed or cancelled AI work as linked replacements:
 * owned evaluations copy into the Run, requested ones re-request shared work.
 */
export async function readmitFailedAiWork(
  db: Database,
  runId: RunId,
  {
    owned,
    requested,
    attempt,
  }: { owned: boolean; requested: boolean; attempt: number },
) {
  const database = getDb(db);
  if (owned) {
    const { aiEvaluation } = await import("~/server/db/schema");
    const failed = await database
      .select()
      .from(aiEvaluation)
      .where(
        and(
          eq(aiEvaluation.runId, runId),
          inArray(aiEvaluation.state, ["failed", "cancelled"]),
          sql`${aiEvaluation.receipt}->>'retryEvaluationId' IS NULL`,
        ),
      );
    await withTransactionDatabase(db, async (tx) => {
      const database = getDb(tx);
      for (const item of failed) {
        const retryId = crypto.randomUUID();
        const [replacement] = await database
          .insert(aiEvaluation)
          .values({
            id: retryId,
            runId: item.runId,
            workKey: `${item.workKey}:operator-retry:${attempt + 1}`,
            feature: item.feature,
            target: item.target,
            provenance: item.provenance,
            snapshot: item.snapshot,
            result: item.result,
            state: item.result ? "result_ready" : "queued",
          })
          .onConflictDoNothing()
          .returning({ id: aiEvaluation.id });
        if (replacement) {
          await enqueueJob(tx, {
            key: `ai-evaluation:${replacement.id}`,
            kind: "ai.evaluation",
            input: { evaluationId: replacement.id },
          });
          await database
            .update(aiEvaluation)
            .set({ receipt: { retryEvaluationId: replacement.id } })
            .where(eq(aiEvaluation.id, item.id));
        }
      }
    });
  }
  if (!requested) return;
  const { aiEvaluationRequest } = await import("~/server/db/schema");
  const { enqueueAiEvaluation, requestedAiEvaluations } =
    await import("~/server/ai/repo/ai-evaluation-requests");
  for (const item of await requestedAiEvaluations(db, runId, {
    currentOnly: true,
  })) {
    if (!["failed", "cancelled"].includes(item.state)) continue;
    const replacement = await enqueueAiEvaluation(db, {
      runId,
      executionKind: item.executionKind,
      shareKey:
        item.state === "cancelled"
          ? `${item.workKey}:member-retry:${attempt + 1}`
          : (item.shareKey ?? item.workKey),
      feature: item.feature,
      target: item.target,
      provenance: item.provenance,
      snapshot: item.snapshot,
      result: item.result,
      state: item.result ? "result_ready" : "queued",
    });
    await database
      .update(aiEvaluationRequest)
      .set({
        receipt: {
          retainedReceipt: item.receipt,
          retryEvaluationId: replacement.id,
        },
      })
      .where(
        and(
          eq(aiEvaluationRequest.runId, runId),
          eq(aiEvaluationRequest.evaluationId, item.id),
        ),
      );
  }
}
