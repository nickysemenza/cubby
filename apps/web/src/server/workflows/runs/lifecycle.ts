import { aiRefreshRunInput } from "@cubby/schemas/ai-evaluation";
import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import { runStatus } from "@cubby/schemas/run-fields";
import { MAX_AUTOMATIC_WORKFLOW_FAILURES } from "@cubby/schemas/workflow-runs";
import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";
import { and, eq, getTableColumns, inArray, lt, sql } from "drizzle-orm";

import {
  describeErrorCauses,
  scrubErrorMessage,
} from "~/lib/error-diagnostics";
import { getAiGatewayEgress } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers/core";
import { run as runTable } from "~/server/db/schema";
import {
  hasAiRefreshRunCapacity,
  tryLockAiRefreshScheduling,
  AI_REFRESH_SCHEDULING_LOCK,
} from "~/server/domains/run/repo/ai-refresh-admission";
import { recordRunProgress as recordProgress } from "~/server/domains/run/repo/run-progress";

import {
  WORKFLOW_RUN_PURPOSES,
  isWorkflowRunPurpose,
  workflowInstanceId,
  type WorkflowRunParams,
  type WorkflowRunPurpose,
} from "./contract";
import {
  ENDED_INSTANCE_STATES,
  productionWorkflowLauncher,
  type WorkflowLauncher,
} from "./launcher";

/**
 * A failure as the Run keeps it: a one-line headline (HTTP status, error
 * code), then every scrubbed cause in full — upstream bodies, SQL text and
 * parameters survive; only credential-shaped values are redacted — then the
 * Sentry event.
 */
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

const attemptOf = sql<number>`coalesce((${runTable.progress}->>'attempt')::int, 0)`;
const attemptIs = (attempt: number) => sql`${attemptOf} = ${attempt}`;

/** Workflow producers carry their originating attempt and ordered delivery position. */
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
    generation: `workflow:${stamp.attempt}`,
    sequence: stamp.sequence,
    phase,
    detail,
  });

/**
 * Start the next attempt of a Workflow-backed Run: bump `progress.attempt`,
 * reopen the Run, then create the instance. A Run another attempt is still
 * running is refused. When Cloudflare refuses the instance, the Run fails
 * with that reason so it never sits `running` with nothing behind it.
 */
type LaunchWorkflowRunInput = {
  runId: RunId;
  purpose: WorkflowRunPurpose;
  /**
   * Recovery cannot undo cancellation or reopen a completed Run. Concurrent
   * recoveries race for one attempt, so an automatic launch that finds the Run
   * already running, ended or cancelled resolves `null` instead of throwing.
   */
  automatic?: boolean;
  /** Explicit rediscovery reports busy admission while retaining automatic recovery fences. */
  reportAdmissionRefusal?: true;
  /** Only the member's explicit retry control may clear a cancellation. */
  retryCancelled?: true;
  /** A bounded instance hands off only while it still owns this attempt. */
  expectedAttempt?: number;
};
type LaunchedWorkflowRun = { attempt: number; instanceId: string };

export async function launchWorkflowRun(
  db: Database,
  input: LaunchWorkflowRunInput & { automatic: true },
  launcher?: WorkflowLauncher,
): Promise<LaunchedWorkflowRun | null>;
export async function launchWorkflowRun(
  db: Database,
  input: LaunchWorkflowRunInput & { automatic?: false },
  launcher?: WorkflowLauncher,
): Promise<LaunchedWorkflowRun>;
export async function launchWorkflowRun(
  db: Database,
  input: LaunchWorkflowRunInput,
  launcher: WorkflowLauncher = productionWorkflowLauncher,
): Promise<LaunchedWorkflowRun | null> {
  let refusal = "This Run is already running; wait for it or cancel it.";
  let admissionRefused = false;
  const reopened = await withTransactionDatabase(db, async (tx) => {
    const database = getDb(tx);
    if (input.purpose === "ai_refresh" && input.expectedAttempt === undefined) {
      const [owner] = await database
        .select({
          status: runTable.status,
          discovery: sql<boolean>`coalesce((${runTable.input}->>${aiRefreshRunInput.keyof().enum.discovery})::boolean, false)`,
          parentRunId: runTable.parentRunId,
        })
        .from(runTable)
        .where(eq(runTable.id, input.runId));
      if (!owner) {
        refusal = "The Run no longer exists.";
        return null;
      }
      if (!owner.parentRunId && !owner.discovery) {
        if (!(await tryLockAiRefreshScheduling(tx))) {
          admissionRefused = true;
          refusal = `AI refresh scheduling is busy (${AI_REFRESH_SCHEDULING_LOCK}); retry shortly.`;
          return null;
        }
        if (!(await hasAiRefreshRunCapacity(tx, input.runId))) {
          admissionRefused = true;
          refusal =
            "AI refresh execution has no free Run slots; wait for active or paused Runs to finish or cancel one.";
          return null;
        }
      }
    }
    const [claimed] = await database
      .update(runTable)
      .set({
        status: "running",
        endedAt: null,
        failureCode: null,
        dispatchError: null,
        routine: false,
        progress: sql`coalesce(${runTable.progress}, '{}'::jsonb) || jsonb_build_object('attempt', ${attemptOf} + 1, 'automaticRecoveryFailures', ${input.automatic || input.expectedAttempt !== undefined ? sql`CASE WHEN ${runTable.status} IN (${runStatus.enum.failed}, ${runStatus.enum.dispatch_failed}) THEN coalesce((${runTable.progress}->>'automaticRecoveryFailures')::int, 0) + 1 ELSE coalesce((${runTable.progress}->>'automaticRecoveryFailures')::int, 0) END` : 0}::int)`,
      })
      .where(
        and(
          eq(runTable.id, input.runId),
          input.retryCancelled && !input.automatic
            ? undefined
            : sql`${runTable.failureCode} IS DISTINCT FROM 'user_cancelled'`,
          input.expectedAttempt === undefined
            ? sql`(${runTable.status} <> 'running' OR ${attemptOf} = 0)`
            : and(
                eq(runTable.status, "running"),
                attemptIs(input.expectedAttempt),
              ),
          input.automatic
            ? and(
                inArray(runTable.status, [
                  "running",
                  "failed",
                  "dispatch_failed",
                  "paused_auth",
                ]),
                sql`(${runTable.status} NOT IN (${runStatus.enum.failed}, ${runStatus.enum.dispatch_failed}) OR coalesce((${runTable.progress}->>'automaticRecoveryFailures')::int, 0) < ${MAX_AUTOMATIC_WORKFLOW_FAILURES})`,
              )
            : undefined,
        ),
      )
      .returning({ shortcode: runTable.shortcode, attempt: attemptOf });
    if (!claimed && !input.automatic) {
      const [current] = await database
        .select({
          status: runTable.status,
          failureCode: runTable.failureCode,
          attempt: attemptOf,
        })
        .from(runTable)
        .where(eq(runTable.id, input.runId));
      refusal =
        current?.failureCode === "user_cancelled"
          ? "This Run was cancelled by a member; use explicit Run Retry to restart it."
          : `This Run is already running or no longer matches the launch: status=${current?.status ?? "missing"}, failureCode=${current?.failureCode ?? "none"}, attempt=${current?.attempt ?? "missing"}, expectedAttempt=${input.expectedAttempt ?? "initial or stopped"}.`;
    }
    return claimed ?? null;
  });
  if (!reopened) {
    if (input.automatic && !(input.reportAdmissionRefusal && admissionRefused))
      return null;
    throw new Error(refusal);
  }
  const instanceId = workflowInstanceId(reopened.shortcode, reopened.attempt);
  await recordRunProgress(
    db,
    input.runId,
    "attempt_started",
    `Started Workflow instance ${instanceId}`,
    { attempt: reopened.attempt, sequence: 0 },
  );
  try {
    if (
      input.purpose === "mail_reclassify" ||
      input.purpose === "suggestion_sweep"
    )
      await getAiGatewayEgress(CUBBY_AI_GATEWAY_ID)?.scheduleAiWorkRecovery(
        input.runId,
      );
    await launcher.create(input.purpose, instanceId, {
      runId: input.runId,
      attempt: reopened.attempt,
    });
  } catch (error) {
    await failWorkflowRun(
      db,
      { runId: input.runId, attempt: reopened.attempt },
      {
        failureCode: "workflow_dispatch_failed",
        message: runFailureText(error instanceof Error ? error : String(error)),
      },
    );
    throw error;
  }
  return { attempt: reopened.attempt, instanceId };
}

/**
 * The Run a step may act on: still running and still owned by this attempt.
 * Null once it was cancelled, failed, or superseded by a retry — the step
 * then stops instead of writing over the newer attempt.
 */
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
  const [row] = await getDb(db)
    .select(
      projection === "id" ? { id: runTable.id } : getTableColumns(runTable),
    )
    .from(runTable)
    .where(
      and(
        eq(runTable.id, runEntityId.parse(params.runId)),
        eq(runTable.status, "running"),
        attemptIs(params.attempt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** End this attempt's Run as failed; a later attempt or a cancel is left alone. */
export async function failWorkflowRun(
  db: Database,
  params: WorkflowRunParams,
  input: { failureCode: string; message: string },
): Promise<boolean> {
  const runId = runEntityId.parse(params.runId);
  // A partially committed failure would make the fresh retry's running-status
  // fence skip its combined diagnostic. Commit the status and timeline together.
  return withTransactionDatabase(db, async (tx) => {
    const [failed] = await getDb(tx)
      .update(runTable)
      .set({
        status: "failed",
        endedAt: new Date(),
        failureCode: input.failureCode,
        dispatchError: input.message,
        progress: sql`coalesce(${runTable.progress}, '{}'::jsonb) || '{"phase":"failed"}'::jsonb`,
      })
      .where(
        and(
          eq(runTable.id, runId),
          eq(runTable.status, "running"),
          attemptIs(params.attempt),
        ),
      )
      .returning({ id: runTable.id });
    if (!failed) return false;
    await recordRunProgress(
      tx,
      runId,
      "failed",
      input.message.split("\n", 1)[0] ?? "",
      { attempt: params.attempt, sequence: Number.MAX_SAFE_INTEGER },
    );
    await (await import("./wake")).wakeStepRunParent(tx, runId);
    return true;
  });
}

/** Quiet this long before a running Run's instance is checked. */
const RECONCILE_AFTER_MS = 30 * 60_000;

/**
 * Cron backstop: a Run still `running` whose instance has ended (errored
 * before its failure step, terminated, expired) or was never created is
 * failed with what Cloudflare reports, so it neither lingers nor blocks the
 * next scheduled pass. A waiting or running instance is left alone.
 */
export async function reconcileWorkflowRuns(
  db: Database,
  launcher: WorkflowLauncher = productionWorkflowLauncher,
  now = new Date(),
): Promise<number> {
  const stale = await getDb(db)
    .select({
      id: runTable.id,
      shortcode: runTable.shortcode,
      purpose: runTable.purpose,
      attempt: attemptOf,
    })
    .from(runTable)
    .where(
      and(
        inArray(runTable.purpose, [...WORKFLOW_RUN_PURPOSES]),
        eq(runTable.status, "running"),
        lt(runTable.updatedAt, new Date(now.getTime() - RECONCILE_AFTER_MS)),
      ),
    );
  let failed = 0;
  for (const row of stale) {
    if (!isWorkflowRunPurpose(row.purpose)) continue;
    const params = { runId: row.id, attempt: row.attempt };
    if (row.attempt === 0) {
      if (
        await failWorkflowRun(db, params, {
          failureCode: "workflow_dispatch_failed",
          message: "The Run was saved but its Workflow was never started",
        })
      )
        failed += 1;
      continue;
    }
    const instanceId = workflowInstanceId(row.shortcode, row.attempt);
    const status = await launcher.status(row.purpose, instanceId);
    if (!ENDED_INSTANCE_STATES.has(status.state)) continue;
    const detail = status.error ? `: ${status.error}` : "";
    if (
      await failWorkflowRun(db, params, {
        failureCode: "workflow_instance_ended",
        message: `Workflow instance ${instanceId} ended (${status.state}) without finishing the Run${detail}`,
      })
    )
      failed += 1;
  }
  return failed;
}
