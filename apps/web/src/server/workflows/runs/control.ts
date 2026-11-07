import {
  aiEvaluationState,
  MEMBER_CANCELLED_AI_WORK,
} from "@cubby/schemas/ai-evaluation";
import type { ActorContext } from "@cubby/schemas/context";
import { runShortcode, type RunId } from "@cubby/schemas/identifiers";
import {
  OWNED_AI_WORK_PURPOSES,
  type RunControlAction,
} from "@cubby/schemas/run-fields";
import { runStepState } from "@cubby/schemas/run-step";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import {
  dropAiEvaluationWork,
  markAiEvaluationWork,
} from "~/server/ai/evaluation/repo/ai-evaluation-work";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { ledgerParty, runStep, run as runTable } from "~/server/db/schema";
import { systemActor } from "~/server/domains/run/repo/ensure-run";
import { recordPaidGrant } from "~/server/domains/run/repo/paid-grant";
import { reopenRunStep } from "~/server/domains/run/repo/run-step";
import { createAppError } from "~/server/errors/app-error";
import { readJob } from "~/server/generic/jobs/repo/job-reads";
import { cancelRunJobs, pauseJob } from "~/server/generic/jobs/repo/operator";

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
      (purpose !== "mail_reclassify" && purpose !== "sweep") ||
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
      const execution = await readJob(tx, { key: `run:${row.id}` });
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
        await import("~/server/ai/evaluation/repo/ai-evaluation-requests");
      if (
        !(await requestedAiEvaluations(db, row.id, { currentOnly: true }))
          .length
      )
        throw createAppError(
          "RUN_CONTROL_REFUSED",
          "This legacy Run retains historical receipts; historical recovery creates a linked continuation rather than retrying its empty roster.",
        );
    }
    if (ownsAiWork(purpose) || requestsAiWork(purpose)) {
      const admitted = await readmitFailedAiWork(db, row.id, {
        owned: ownsAiWork(purpose),
        requested: requestsAiWork(purpose),
        attempt: row.attempt,
        reviveCancelled: row.failureCode === "user_cancelled",
      });
      if (row.failureCode === "user_cancelled" && admitted === 0) {
        const [failedStep] = await database
          .select({ id: runStep.id })
          .from(runStep)
          .where(and(eq(runStep.runId, row.id), sql`${runStep.failed} > 0`))
          .limit(1);
        if (!failedStep)
          throw createAppError(
            "RUN_CONTROL_REFUSED",
            "This cancelled Run has no re-admissible work; start a new Run to evaluate that scope again.",
          );
      }
    }
    if (row.failureCode === "user_cancelled") {
      const stoppedSteps = await database
        .select({ key: runStep.key })
        .from(runStep)
        .where(
          and(
            eq(runStep.runId, row.id),
            eq(runStep.state, runStepState.enum.failed),
            eq(runStep.pausedReason, MEMBER_CANCELLED_AI_WORK),
          ),
        );
      // Re-admitted items still need their interrupted evaluate step to wait for them.
      for (const step of stoppedSteps)
        await reopenRunStep(db, row.id, step.key);
    }
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
        dispatchError: MEMBER_CANCELLED_AI_WORK,
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
    // Cancellation ends execution, without inventing item failures or losing its retry cursor.
    await database
      .update(runStep)
      .set({
        state: runStepState.enum.failed,
        endedAt: new Date(),
        pausedReason: MEMBER_CANCELLED_AI_WORK,
        pausedUntil: null,
      })
      .where(
        and(
          eq(runStep.runId, row.id),
          eq(runStep.state, runStepState.enum.running),
        ),
      );
    return cancelRunAiWork(tx, row.id, MEMBER_CANCELLED_AI_WORK, {
      owned: ownsAiWork(purpose),
      requested: requestsAiWork(purpose),
    });
  });
  await recordRunProgress(db, row.id, "cancelled", MEMBER_CANCELLED_AI_WORK, {
    attempt: row.attempt,
    sequence: Number.MAX_SAFE_INTEGER,
  });
}

/**
 * Stops a Run's pending AI work: evaluations it owns become cancelled and
 * its requests on shared evaluations are withdrawn; their items drop.
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
            inArray(aiEvaluation.state, ["queued", "result_ready"]),
          ),
        );
    }
    let sharedDemand = false;
    if (scope.requested) {
      const { cancelAiEvaluationRequests } =
        await import("~/server/ai/evaluation/repo/ai-evaluation-requests");
      sharedDemand = await cancelAiEvaluationRequests(tx, runId);
    }
    // Only work nobody else still wants was cancelled; another requester's
    // pending evaluation keeps its item.
    await dropAiEvaluationWork(
      tx,
      sql`"AiEvaluation".state = ${aiEvaluationState.enum.cancelled}
        AND ("AiEvaluation"."runId" = ${runId}::uuid
          OR EXISTS (SELECT 1 FROM "AiEvaluationRequest" r WHERE r."evaluationId" = "AiEvaluation".id AND r."runId" = ${runId}::uuid))`,
    );
    return sharedDemand;
  });
}

/**
 * Re-admits failed AI work as linked replacements. Only an explicit retry of a
 * member-cancelled Run revokes that member stop; superseded work stays stopped:
 * owned evaluations copy into the Run, requested ones re-request shared work.
 */
export async function readmitFailedAiWork(
  db: Database,
  runId: RunId,
  {
    owned,
    requested,
    attempt,
    reviveCancelled = false,
  }: {
    owned: boolean;
    requested: boolean;
    attempt: number;
    reviveCancelled?: boolean;
  },
): Promise<number> {
  const database = getDb(db);
  let admitted = 0;
  if (owned) {
    const { aiEvaluation, aiEvaluationRequest } =
      await import("~/server/db/schema");
    const failed = await database
      .select()
      .from(aiEvaluation)
      .where(
        and(
          eq(aiEvaluation.runId, runId),
          or(
            eq(aiEvaluation.state, "failed"),
            reviveCancelled
              ? and(
                  eq(aiEvaluation.state, "cancelled"),
                  eq(aiEvaluation.error, MEMBER_CANCELLED_AI_WORK),
                )
              : undefined,
          ),
          sql`${aiEvaluation.receipt}->>'retryEvaluationId' IS NULL`,
        ),
      );
    admitted += await withTransactionDatabase(db, async (tx) => {
      const database = getDb(tx);
      let created = 0;
      const replacements = new Map<string, string>();
      for (const item of failed) {
        const retryId = crypto.randomUUID();
        const [replacement] = await database
          .insert(aiEvaluation)
          .values({
            id: retryId,
            runId: item.runId,
            executionKind: item.executionKind,
            shareKey: item.shareKey,
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
          created += 1;
          replacements.set(item.id, replacement.id);
          await markAiEvaluationWork(tx, [replacement.id]);
          await database
            .update(aiEvaluation)
            .set({ receipt: { retryEvaluationId: replacement.id } })
            .where(eq(aiEvaluation.id, item.id));
        }
      }
      if (replacements.size) {
        // Sweep steps tally requests, even when the same Run also owns the evaluation.
        const requests = await database
          .select()
          .from(aiEvaluationRequest)
          .where(
            and(
              eq(aiEvaluationRequest.runId, runId),
              inArray(aiEvaluationRequest.evaluationId, [
                ...replacements.keys(),
              ]),
              reviveCancelled
                ? undefined
                : sql`${aiEvaluationRequest.cancelledAt} IS NULL`,
            ),
          );
        if (requests.length)
          await database
            .insert(aiEvaluationRequest)
            .values(
              requests.map((request) => ({
                runId,
                evaluationId: replacements.get(request.evaluationId)!,
                sequence: request.sequence,
              })),
            )
            .onConflictDoNothing();
      }
      return created;
    });
  }
  if (!requested) return admitted;
  const { aiEvaluationRequest } = await import("~/server/db/schema");
  const { enqueueAiEvaluation, requestedAiEvaluations } =
    await import("~/server/ai/evaluation/repo/ai-evaluation-requests");
  for (const item of await requestedAiEvaluations(db, runId, {
    currentOnly: true,
  })) {
    if (
      item.state !== "failed" &&
      !(
        reviveCancelled &&
        item.state === "cancelled" &&
        item.error === MEMBER_CANCELLED_AI_WORK
      )
    )
      continue;
    const replacement = await enqueueAiEvaluation(db, {
      runId,
      executionKind: item.executionKind,
      shareKey: item.shareKey ?? item.workKey,
      feature: item.feature,
      target: item.target,
      provenance: item.provenance,
      snapshot: item.snapshot,
      result: item.result,
      state: item.result ? "result_ready" : "queued",
    });
    admitted += 1;
    if (replacement.id === item.id) {
      // Another requester kept this slot live: restore demand on its existing row.
      await database
        .update(aiEvaluationRequest)
        .set({ cancelledAt: null })
        .where(
          and(
            eq(aiEvaluationRequest.runId, runId),
            eq(aiEvaluationRequest.evaluationId, item.id),
          ),
        );
      continue;
    }
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
  return admitted;
}
