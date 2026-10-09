import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import type { MailDiscoveryRunProgress } from "@cubby/schemas/run-fields";
import { and, eq, inArray, lt, sql } from "drizzle-orm";

import {
  describeErrorCauses,
  scrubErrorMessage,
} from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import { run as runTable, runProgress } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

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

/** Progress a new attempt resets, in its purpose's own shape. */
export type RunProgressPatch = Partial<MailDiscoveryRunProgress>;

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

/** Append one durable progress line to a Run. */
export const recordRunProgress = (
  db: Database,
  runId: RunId,
  phase: string,
  detail: string,
) =>
  getDb(db).insert(runProgress).values({
    runId,
    eventId: crypto.randomUUID(),
    phase,
    detail,
  });

/**
 * Start the next attempt of a Workflow-backed Run: bump `progress.attempt`,
 * reopen the Run, then create the instance. A Run another attempt is still
 * running is refused. When Cloudflare refuses the instance, the Run fails
 * with that reason so it never sits `running` with nothing behind it.
 */
export async function launchWorkflowRun(
  db: Database,
  input: {
    runId: RunId;
    purpose: WorkflowRunPurpose;
    /** Purpose-specific progress to reset for the new attempt. */
    progressPatch?: RunProgressPatch;
  },
  launcher: WorkflowLauncher = productionWorkflowLauncher,
): Promise<{ attempt: number; instanceId: string }> {
  const database = getDb(db);
  const patch = JSON.stringify(input.progressPatch ?? {});
  const [reopened] = await database
    .update(runTable)
    .set({
      status: "running",
      endedAt: null,
      failureCode: null,
      dispatchError: null,
      routine: false,
      progress: sql`coalesce(${runTable.progress}, '{}'::jsonb) || ${patch}::jsonb || jsonb_build_object('attempt', ${attemptOf} + 1)`,
    })
    .where(
      and(
        eq(runTable.id, input.runId),
        sql`(${runTable.status} <> 'running' OR ${attemptOf} = 0)`,
      ),
    )
    .returning({ shortcode: runTable.shortcode, attempt: attemptOf });
  if (!reopened)
    throw new Error("This Run is already running; wait for it or cancel it.");
  const instanceId = workflowInstanceId(reopened.shortcode, reopened.attempt);
  await recordRunProgress(
    db,
    input.runId,
    "attempt_started",
    `Started Workflow instance ${instanceId}`,
  );
  try {
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
export async function claimWorkflowRun(
  db: Database,
  params: WorkflowRunParams,
) {
  const [row] = await getDb(db)
    .select()
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
  const [failed] = await getDb(db)
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
    db,
    runId,
    "failed",
    input.message.split("\n", 1)[0] ?? "",
  );
  return true;
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
