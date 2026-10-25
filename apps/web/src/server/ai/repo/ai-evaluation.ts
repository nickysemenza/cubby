import {
  aiRefreshProgress,
  aiProvenance,
  aiEvaluationTarget,
} from "@cubby/schemas/ai-evaluation";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { dependenciesCurrent } from "~/server/ai/policy/refresh-manifest";
import {
  aiExecutionOwner,
  liveAiRequestRun,
  PENDING_AI_STATES,
} from "~/server/ai/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { aiEvaluation, aiEvaluationRequest, run } from "~/server/db/schema";
import { JobPausedError, JobDeferredError } from "~/server/generic/jobs/errors";
import { aiEvaluationJobInput } from "~/server/generic/jobs/inputs";
import {
  assertCurrentJob,
  currentJobExecution,
} from "~/server/generic/jobs/repo/execution";

import { readAiRefreshActivation } from "./ai-refresh";

/** The universal Job is the only inference/apply owner. Domain rows retain evidence. */
export async function claimAiEvaluation(
  db: Database,
  id: string,
  requestingRunId?: string,
) {
  const execution = currentJobExecution();
  if (
    !execution ||
    execution.claim.kind !== "ai.evaluation" ||
    aiEvaluationJobInput.parse(execution.claim.input).evaluationId !== id
  )
    throw new Error("AI evaluation execution requires its universal Job claim");
  return withTransactionDatabase(db, async (tx) => {
    // Hold Job ownership through the evaluation write and its commit.
    await assertCurrentJob(tx);
    const [existing] = await getDb(tx)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.id, id));
    if (!existing || !PENDING_AI_STATES.includes(existing.state)) return null;
    if (
      existing.executionKind === "ai_refresh" &&
      !(await readAiRefreshActivation(tx))?.enabled
    )
      throw new JobDeferredError(
        "Automatic AI refresh is disabled",
        new Date(Date.now() + 120_000),
        "provider_capacity",
      );
    const owner = await aiExecutionOwner(tx, existing, requestingRunId);
    if (!owner)
      throw new JobPausedError("No live requester authorizes AI evaluation");
    const [row] = await getDb(tx)
      .update(aiEvaluation)
      .set({
        state: existing.result ? "result_ready" : "running",
        runId: owner.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiEvaluation.id, id),
          inArray(aiEvaluation.state, PENDING_AI_STATES),
        ),
      )
      .returning();
    return row
      ? {
          ...row,
          attemptToken: execution.claim.leaseToken,
          attempts: execution.claim.attempts,
        }
      : null;
  });
}

/** The active manifest and Run state are read in the business-write transaction. */
export async function guardAiEvaluation(
  tx: Database,
  id: string,
  token: string,
) {
  await (
    await import("~/server/workflows/runs/execution")
  ).assertWorkflowEffect(tx);
  const execution = currentJobExecution();
  if (
    !execution ||
    execution.claim.leaseToken !== token ||
    aiEvaluationJobInput.parse(execution.claim.input).evaluationId !== id
  )
    throw new Error("AI evaluation attempt is obsolete");
  const [read] = await getDb(tx)
    .select()
    .from(aiEvaluation)
    .where(eq(aiEvaluation.id, id));
  if (!read) throw new Error("AI evaluation attempt is obsolete");
  const activation =
    read.executionKind === "ai_refresh"
      ? await readAiRefreshActivation(tx)
      : null;
  // Match cancellation's Run-before-item lock order. A shared item's original
  // requester may stop while another live requester still wants publication.
  const owners = await getDb(tx)
    .select()
    .from(run)
    .where(
      read.executionKind === "ai_refresh"
        ? eq(run.id, read.runId)
        : or(eq(run.id, read.runId), liveAiRequestRun(id)),
    )
    .orderBy(run.id)
    .for("no key update");
  const [row] = await getDb(tx)
    .select()
    .from(aiEvaluation)
    .where(
      and(
        eq(aiEvaluation.id, id),
        inArray(aiEvaluation.state, ["running", "result_ready"]),
      ),
    )
    .for("update");
  if (!row) throw new Error("AI evaluation attempt is obsolete");
  const owner = owners.find((entry) => entry.id === row.runId);
  if (
    !owner ||
    !owners.some(
      (entry) =>
        entry.status === "running" && !entry.deletedAt && !entry.retiredAt,
    ) ||
    (row.executionKind === "ai_refresh" &&
      (!activation?.enabled ||
        !dependenciesCurrent(
          aiProvenance.parse(row.provenance),
          activation.manifest,
        )))
  )
    throw new Error("AI evaluation generation or Run is obsolete");
  return { row, target: aiEvaluationTarget.parse(row.target) };
}

/** Held only for final writes/commit, never snapshot preparation or requester wakeup. */
async function fenceAiEvaluationActivation(
  tx: Database,
  row: Pick<typeof aiEvaluation.$inferSelect, "executionKind" | "provenance">,
) {
  if (row.executionKind !== "ai_refresh") return;
  const activation = await readAiRefreshActivation(tx, "share");
  if (
    !activation?.enabled ||
    !dependenciesCurrent(
      aiProvenance.parse(row.provenance),
      activation.manifest,
    )
  )
    throw new Error("AI evaluation generation or Run is obsolete");
}

export async function completeAiEvaluation(
  tx: Database,
  id: string,
  token: string,
  receipt: unknown,
  state: "completed" | "blocked" | "obsolete" = "completed",
) {
  await guardAiEvaluation(tx, id, token);
  await settleAiEvaluation(tx, id, z.json().parse(receipt), state);
}

type EvaluationReceipt = z.output<ReturnType<typeof z.json>>;

/** Completion for a transaction that already holds `guardAiEvaluation`'s locks. */
async function settleAiEvaluation(
  tx: Database,
  id: string,
  receipt: EvaluationReceipt,
  state: "completed" | "blocked" | "obsolete",
) {
  const [row] = await getDb(tx)
    .update(aiEvaluation)
    .set({
      state,
      receipt,
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(aiEvaluation.id, id))
    .returning({
      executionKind: aiEvaluation.executionKind,
      provenance: aiEvaluation.provenance,
    });
  if (!row) throw new Error("AI evaluation attempt is obsolete");
  await getDb(tx)
    .update(aiEvaluationRequest)
    .set({ receipt })
    .where(
      and(
        eq(aiEvaluationRequest.evaluationId, id),
        isNull(aiEvaluationRequest.cancelledAt),
        sql`${aiEvaluationRequest.receipt}->>'retryEvaluationId' IS NULL`,
      ),
    );
  await (
    await import("~/server/workflows/runs/wake")
  ).wakeAiEvaluationRequesters(tx, id);
  await fenceAiEvaluationActivation(tx, row);
}

export async function publishAiEvaluation<T>(
  db: Database,
  id: string,
  token: string,
  work: (tx: Database) => Promise<T>,
  settlement: "complete" | "continue" = "complete",
) {
  return withTransactionDatabase(
    db,
    async (tx) => {
      const { row } = await guardAiEvaluation(tx, id, token);
      const result = await work(tx);
      // Acquire the global fence only after business work. SERIALIZABLE rejects
      // activation changed since this transaction's snapshot; the share lock
      // prevents deactivation between this check and commit.
      // The guard above already locked this attempt's Run and row.
      if (settlement === "complete")
        await settleAiEvaluation(tx, id, z.json().parse(result), "completed");
      else await fenceAiEvaluationActivation(tx, row);
      return result;
    },
    { isolationLevel: "serializable" },
  );
}

export function aiEvaluationProgress(
  rows: readonly (typeof aiEvaluation.$inferSelect)[],
  attempt: number,
) {
  const current = rows.filter(
    (row) =>
      !z.object({ retryEvaluationId: z.uuid() }).safeParse(row.receipt).success,
  );
  const count = (state: (typeof aiEvaluation.$inferSelect)["state"]) =>
    current.filter((row) => row.state === state).length;
  return aiRefreshProgress.parse({
    attempt,
    selected: current.length,
    queued: count("queued"),
    running: count("running"),
    retryWait: count("retry_wait"),
    resultReady: count("result_ready"),
    completed: count("completed"),
    blocked: count("blocked"),
    failed: count("failed"),
    obsolete: count("obsolete"),
    cancelled: count("cancelled"),
    errors: current
      .flatMap((row) => (row.error ? [row.error] : []))
      .slice(0, 10),
  });
}
