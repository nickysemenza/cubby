import { aiEvaluationState } from "@cubby/schemas/ai-evaluation";
import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import { jobState } from "@cubby/schemas/job";
import { runStepState } from "@cubby/schemas/run-step";
import { and, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";

import {
  describeErrorCauses,
  scrubErrorMessage,
} from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import {
  getDb,
  withTransactionDatabase,
  runAfterCommit,
} from "~/server/db/helpers/core";
import { run as runTable, job } from "~/server/db/retained-tables";
import { recordRunProgress as recordProgress } from "~/server/domains/run/repo/run-progress";
import {
  assertCurrentJob,
  currentJobExecution,
} from "~/server/generic/jobs/repo/execution";
import { enqueueJob, retryJob } from "~/server/generic/jobs/repo/jobs";

import type { WorkflowRunParams, WorkflowRunPurpose } from "./contract";

export const runFailureText = (
  error: Error | string,
  sentryEventId?: string,
) => {
  const causes = describeErrorCauses(error).causes;
  const status = causes.find((cause) => cause.status)?.status;
  const first = causes[0]?.message ?? scrubErrorMessage(String(error));
  const summary = first.split("\n", 1)[0]?.slice(0, 600) ?? "Operation failed";
  const labelled =
    status && !summary.includes(`HTTP ${status}`)
      ? `HTTP ${status}: ${summary}`
      : summary;
  const coded = causes.find(
    (cause) => cause.code && !labelled.includes(cause.code),
  );
  const headline = coded
    ? `${labelled} · ${coded.code}: ${coded.message.slice(0, 120)}`
    : labelled;
  const details = causes
    .map((cause) => cause.message)
    .filter((message) => message && message !== summary);
  return [
    headline,
    ...new Set(details),
    ...(sentryEventId ? [`Sentry event: ${sentryEventId}`] : []),
  ].join("\n");
};

export const recordRunProgress = (
  db: Database,
  runId: RunId,
  phase: string,
  detail: string,
  stamp: { attempt: number; sequence: number },
) =>
  recordProgress(db, {
    runId,
    eventId: crypto.randomUUID(),
    generation: `job:${currentJobExecution()?.claim.generation ?? stamp.attempt}`,
    sequence: stamp.sequence,
    phase,
    detail,
  });

type LaunchWorkflowRunInput = {
  runId: RunId;
  purpose: WorkflowRunPurpose;
  automatic?: boolean;
};
type LaunchedWorkflowRun = { attempt: number; instanceId: string };

export async function launchWorkflowRun(
  db: Database,
  input: LaunchWorkflowRunInput & { automatic: true },
): Promise<LaunchedWorkflowRun | null>;
export async function launchWorkflowRun(
  db: Database,
  input: LaunchWorkflowRunInput & { automatic?: false },
): Promise<LaunchedWorkflowRun>;
/** Run is provenance/history. The Job row owns execution, retry, pause and cancellation. */
export async function launchWorkflowRun(
  db: Database,
  input: LaunchWorkflowRunInput,
): Promise<LaunchedWorkflowRun | null> {
  return withTransactionDatabase(db, async (tx) => {
    const [owner] = await getDb(tx)
      .select()
      .from(runTable)
      .where(eq(runTable.id, input.runId))
      .for("update");
    if (!owner) throw new Error("Run no longer exists");
    let execution = await enqueueJob(tx, {
      key: `run:${input.runId}`,
      kind: "run.execute",
      priority: input.automatic ? 0 : 100,
      input: { runId: input.runId, purpose: input.purpose },
      runId: input.runId,
    });
    if (["failed", "cancelled", "paused"].includes(execution.state)) {
      if (input.automatic) return null;
      const retried = await retryJob(tx, execution.id);
      if (retried) execution = retried;
    }
    if (execution.state === "completed") {
      if (input.automatic) return null;
      const pending = await getDb(tx).execute<{ pending: boolean }>(sql`SELECT (
        EXISTS (SELECT 1 FROM "AiEvaluation" e WHERE e.state IN (${aiEvaluationState.enum.queued},${aiEvaluationState.enum.running},${aiEvaluationState.enum.retry_wait},${aiEvaluationState.enum.result_ready})
          AND e.receipt->>'retryEvaluationId' IS NULL
          AND (e."runId"=${input.runId}::uuid OR EXISTS (SELECT 1 FROM "AiEvaluationRequest" r WHERE r."evaluationId"=e.id AND r."runId"=${input.runId}::uuid AND r."cancelledAt" IS NULL)))
        OR EXISTS (SELECT 1 FROM "RunStep" s WHERE s."runId"=${input.runId}::uuid AND s.state=${runStepState.enum.queued})
      ) AS pending`);
      if (!pending.rows[0]?.pending)
        throw new Error("Completed Run cannot be relaunched; create a new Run");
      execution = await enqueueJob(tx, {
        key: execution.key,
        kind: execution.kind,
        input: execution.input,
        priority: 100,
        runId: input.runId,
        invalidate: true,
      });
    }
    if (!input.automatic) {
      // A member can promote work originally admitted automatically.
      if (execution.priority < 100)
        await getDb(tx)
          .update(job)
          .set({ priority: 100 })
          .where(eq(job.id, execution.id));
      const pending = await getDb(tx).execute<{
        id: string;
      }>(sql`SELECT j.id FROM "Job" j JOIN "AiEvaluation" e ON j.key='ai-evaluation:' || e.id::text
        WHERE j.state=${jobState.enum.paused} AND (e."runId"=${input.runId}::uuid OR EXISTS (SELECT 1 FROM "AiEvaluationRequest" r WHERE r."evaluationId"=e.id AND r."runId"=${input.runId}::uuid AND r."cancelledAt" IS NULL))`);
      for (const row of pending.rows) await retryJob(tx, row.id);
    }
    await getDb(tx)
      .update(runTable)
      .set({
        status: "running",
        endedAt: null,
        failureCode: null,
        dispatchError: null,
        progress: sql`coalesce(${runTable.progress}, '{}'::jsonb) || jsonb_build_object('attempt', ${execution.generation}::int)`,
      })
      .where(eq(runTable.id, input.runId));
    await runAfterCommit(tx, async () => {
      await (
        await import("../background-tasks/publish")
      ).wakeJobs({ source: "run-launch" });
    });
    return { attempt: execution.generation, instanceId: execution.id };
  });
}

export function claimWorkflowRun(
  db: Database,
  params: WorkflowRunParams,
  projection: "id",
): Promise<{ id: RunId } | null>;
export function claimWorkflowRun(
  db: Database,
  params: WorkflowRunParams,
): Promise<typeof runTable.$inferSelect | null>;
export async function claimWorkflowRun(
  db: Database,
  params: WorkflowRunParams,
  projection?: "id",
) {
  await assertCurrentJob(db);
  const current = currentJobExecution();
  if (
    !current ||
    current.claim.kind !== "run.execute" ||
    current.claim.input === null ||
    typeof current.claim.input !== "object" ||
    !("runId" in current.claim.input) ||
    current.claim.input.runId !== params.runId
  )
    throw new Error(
      "Background Run execution requires its universal Job claim",
    );
  if (current.claim.generation !== params.attempt) return null;
  const [row] = await getDb(db)
    .select(
      projection === "id" ? { id: runTable.id } : getTableColumns(runTable),
    )
    .from(runTable)
    .where(
      and(
        eq(runTable.id, runEntityId.parse(params.runId)),
        eq(runTable.status, "running"),
        isNull(runTable.deletedAt),
        isNull(runTable.retiredAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Terminal domain outcome is retained; retry policy remains exclusively on Job. */
export async function failWorkflowRun(
  db: Database,
  params: WorkflowRunParams,
  input: { failureCode: string; message: string },
): Promise<boolean> {
  if (!currentJobExecution())
    throw new Error("Run failure requires its universal Job claim");
  await assertCurrentJob(db);
  const [failed] = await getDb(db)
    .update(runTable)
    .set({
      status: "failed",
      endedAt: new Date(),
      failureCode: input.failureCode,
      dispatchError: input.message,
    })
    .where(eq(runTable.id, runEntityId.parse(params.runId)))
    .returning({ id: runTable.id });
  return Boolean(failed);
}

/** Lost wakes and interrupted workers are recovered by dueJobs, never new Run attempts. */
export async function reconcileWorkflowRuns(db: Database) {
  const rows = await getDb(db)
    .select({ runId: job.runId, state: job.state, error: job.error })
    .from(job)
    .innerJoin(runTable, eq(runTable.id, job.runId))
    .where(
      and(
        eq(job.kind, "run.execute"),
        eq(runTable.status, "running"),
        inArray(job.state, ["failed", "cancelled", "paused"]),
      ),
    )
    .limit(100);
  for (const row of rows) {
    if (!row.runId || !["failed", "cancelled", "paused"].includes(row.state))
      continue;
    await getDb(db)
      .update(runTable)
      .set({
        status: row.state === "paused" ? "paused" : "failed",
        dispatchError: row.error,
        failureCode:
          row.state === "cancelled"
            ? "user_cancelled"
            : row.state === "failed"
              ? "job_failed"
              : null,
      })
      .where(and(eq(runTable.id, row.runId), eq(runTable.status, "running")));
  }
  return rows.length;
}
