import { aiEvaluationState } from "@cubby/schemas/ai-evaluation";
import type { ActorContext } from "@cubby/schemas/context";
import { runShortcode, type RunId } from "@cubby/schemas/identifiers";
import type { RunControlAction } from "@cubby/schemas/run-fields";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { ledgerParty, run as runTable } from "~/server/db/schema";
import { systemActor } from "~/server/domains/run/repo/ensure-run";
import { recordPaidGrant } from "~/server/domains/run/repo/paid-grant";
import { createAppError } from "~/server/errors/app-error";
import {
  cancelJob,
  cancelRunJobs,
  pauseJob,
  enqueueJob,
} from "~/server/generic/jobs/repo/jobs";

import {
  isStepRunPurpose,
  isWorkflowRunPurpose,
  type WorkflowRunPurpose,
} from "./contract";
import { launchWorkflowRun, recordRunProgress } from "./lifecycle";

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
  purpose: WorkflowRunPurpose,
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
    if (purpose === "ai_refresh") {
      const { aiEvaluation } = await import("~/server/db/schema");
      const failed = await database
        .select()
        .from(aiEvaluation)
        .where(
          and(
            eq(aiEvaluation.runId, row.id),
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
              workKey: `${item.workKey}:operator-retry:${row.attempt + 1}`,
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
    if (purpose === "mail_reclassify" || purpose === "suggestion_sweep") {
      const { aiEvaluationRequest } = await import("~/server/db/schema");
      const { enqueueAiEvaluation, requestedAiEvaluations } =
        await import("~/server/ai/repo/ai-evaluation-requests");
      const requested = await requestedAiEvaluations(db, row.id, {
        currentOnly: true,
      });
      if (purpose === "mail_reclassify" && !requested.length)
        throw createAppError(
          "RUN_CONTROL_REFUSED",
          "This legacy Run retains historical receipts; historical recovery creates a linked continuation rather than retrying its empty roster.",
        );
      for (const item of requested) {
        if (!["failed", "cancelled"].includes(item.state)) continue;
        const replacement = await enqueueAiEvaluation(db, {
          runId: row.id,
          executionKind: item.executionKind,
          shareKey:
            item.state === "cancelled"
              ? `${item.workKey}:member-retry:${row.attempt + 1}`
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
              eq(aiEvaluationRequest.runId, row.id),
              eq(aiEvaluationRequest.evaluationId, item.id),
            ),
          );
      }
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
    if (purpose === "ai_refresh") {
      const { aiEvaluation } = await import("~/server/db/schema");
      await database
        .update(aiEvaluation)
        .set({
          state: "cancelled",
          error: "Cancelled by a member",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiEvaluation.runId, row.id),
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
    if (purpose !== "ai_refresh" && purpose !== "mail_discovery") {
      const { cancelAiEvaluationRequests } =
        await import("~/server/ai/repo/ai-evaluation-requests");
      sharedDemand = await cancelAiEvaluationRequests(tx, row.id);
    }
    await cancelRunJobs(tx, row.id);
    const stopped = await database.execute<{ id: string }>(
      sql`SELECT j.id FROM "Job" j JOIN "AiEvaluation" e ON j.key='ai-evaluation:' || e.id::text WHERE e.state=${aiEvaluationState.enum.cancelled} AND e."runId"=${row.id}::uuid`,
    );
    for (const execution of stopped.rows) await cancelJob(tx, execution.id);
    return sharedDemand;
  });
  await recordRunProgress(db, row.id, "cancelled", "Cancelled by a member", {
    attempt: row.attempt,
    sequence: Number.MAX_SAFE_INTEGER,
  });
  if (isStepRunPurpose(purpose)) await cancelStepChildren(db, actor, row.id);
}

/**
 * A step-ledger Run's children are its own work: cancelling a Sweep stops
 * the field or connection Runs it started, keeping what committed.
 */
export async function cancelStepChildren(
  db: Database,
  actor: ActorContext,
  runId: RunId,
) {
  const { unfinishedStepChildren } =
    await import("~/server/domains/run/repo/run-step");
  for (const child of await unfinishedStepChildren(db, runId))
    if (isWorkflowRunPurpose(child.purpose))
      await controlWorkflowRun(
        db,
        actor,
        { runPublicId: child.shortcode, action: "cancel" },
        child.purpose,
      );
}
