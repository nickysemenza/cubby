import { aiEvaluationState } from "@cubby/schemas/ai-evaluation";
import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import {
  mailboxDiscoveryInput,
  mailboxDiscoveryProgress,
  MAIL_DISCOVERY_ADMISSION_WAIT,
} from "@cubby/schemas/mailbox-research";
import { type ExecutedRunPurpose } from "@cubby/schemas/run-fields";
import { runStepState } from "@cubby/schemas/run-step";
import { createLogger } from "@cubby/worker-tracing";
import { and, or, not, eq, getTableColumns, isNull, sql } from "drizzle-orm";

import {
  describeErrorCauses,
  scrubErrorMessage,
} from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import {
  getDb,
  withTransactionDatabase,
  runAfterCommit,
} from "~/server/db/helpers/core";
import { related, outer } from "~/server/db/helpers/related";
import { run as runTable } from "~/server/db/retained-tables";
import {
  lockMailDiscoveryRunAdmission,
  mailDiscoveryAdmission,
  mailDiscoveryShouldYield,
  retainedMailDiscoveryScope,
} from "~/server/domains/purchase-import/repo/gmail/discovery-admission";
import { recordRunProgress as recordProgress } from "~/server/domains/run/repo/run-progress";
import { createAppError } from "~/server/errors/app-error";
import { findPgError } from "~/server/errors/db-errors";
import { currentJobExecution } from "~/server/generic/jobs/context";
import {
  JobDeferredError,
  JobRetryableError,
} from "~/server/generic/jobs/errors";
import { classifyJobFailure, stopsPage } from "~/server/generic/jobs/failure";
import {
  lockUnchangedJob,
  stoppedRunExecutions,
  stoppedRunExecutionsExist,
} from "~/server/generic/jobs/repo/job-reads";
import {
  makeJobsDueNow,
  prioritizeJob,
  retryJob,
} from "~/server/generic/jobs/repo/operator";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { assertWorkflowEffect } from "~/server/workflows/runs/execution";

import { type WorkflowRunParams } from "./contract";

const log = createLogger("workflow");

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

/**
 * A member's launch, resume or retry outranks unattended Run execution:
 * priority orders Jobs within one kind, never across kinds.
 */
export const MANUAL_RUN_PRIORITY = 10;

/** An aborted Mail snapshot waits on its canonical Job without spending attempts. */
export function mailDiscoveryBackpressure(
  error: UnparsedError,
): Error | undefined {
  // A wrapped database cause cannot turn cancellation or lease loss into demand.
  if (stopsPage(classifyJobFailure(error))) return undefined;
  const pg = findPgError(error);
  if (
    !pg ||
    (!["40001", "40P01", "55P03", "53300"].includes(pg.code ?? "") &&
      !(
        pg.code === "23505" && pg.constraint === "Run_one_active_mail_discovery"
      ))
  )
    return undefined;
  log.warn("Mail discovery database capacity wait", { error });
  const message =
    "Mail discovery is waiting for shared database or search capacity";
  if (!currentJobExecution())
    return createAppError("RUN_CONTROL_REFUSED", message, error);
  const deferred = new JobDeferredError(
    message,
    new Date(Date.now() + 15_000),
    "provider_capacity",
  );
  deferred.cause = error;
  return deferred;
}

type LaunchWorkflowRunInput = {
  runId: RunId;
  purpose: ExecutedRunPurpose;
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
    const mailbox = await lockMailDiscoveryRunAdmission(tx, input.runId);
    const [owner] = await getDb(tx)
      .select()
      .from(runTable)
      .where(eq(runTable.id, input.runId))
      .for("update");
    if (!owner) throw new Error("Run no longer exists");
    if (
      input.automatic &&
      owner.purpose === "mail_discovery" &&
      owner.status !== "running" &&
      !(
        owner.status === "paused" &&
        owner.failureCode === MAIL_DISCOVERY_ADMISSION_WAIT
      )
    )
      return null;
    if (
      mailbox &&
      (owner.ledgerPartyId !== mailbox.ledgerPartyId ||
        mailboxDiscoveryInput.parse(owner.input).mailboxId !==
          mailbox.mailboxId)
    )
      throw new Error("Mail discovery admission identity changed");
    const scope = mailbox ? retainedMailDiscoveryScope(owner) : undefined;
    const admissionClass = mailboxDiscoveryProgress.safeParse(owner.progress)
      .data?.admissionClass;
    const recovery =
      mailbox &&
      (owner.status === "running" ||
        owner.failureCode === MAIL_DISCOVERY_ADMISSION_WAIT)
        ? admissionClass === "recovery"
        : !input.automatic;
    const admitted =
      !mailbox ||
      !scope ||
      owner.status === "running" ||
      (await mailDiscoveryAdmission(tx, {
        ...mailbox,
        scope,
        runId: owner.id,
        recovery,
      })) === "available";
    const admissionProgress = scope
      ? {
          discoveryScope: scope,
          admissionClass: recovery ? "recovery" : "automatic",
          ...(!admitted
            ? {
                admissionRequestedAt:
                  mailboxDiscoveryProgress.parse(owner.progress)
                    .admissionRequestedAt ?? new Date().toISOString(),
              }
            : {}),
        }
      : {};
    const priority = input.automatic ? 0 : MANUAL_RUN_PRIORITY;
    // Retention prunes the finished Job, so the Run's status has to refuse automatic
    // work as the row would.
    if (
      input.automatic &&
      ["completed", "failed", "cancelled"].includes(owner.status)
    )
      return null;
    let execution = await enqueueJob(tx, {
      key: `run:${input.runId}`,
      kind: "run.execute",
      input: { runId: input.runId, purpose: input.purpose },
      runId: input.runId,
      priority,
    });
    if (["failed", "cancelled", "paused"].includes(execution.state)) {
      if (input.automatic) return null;
      const retried = await retryJob(tx, execution.id);
      if (retried) execution = retried;
    }
    if (
      execution.state === "completed" ||
      // Its finished Job was pruned, so this row is new and the same rule applies.
      (owner.status === "completed" &&
        execution.generation === 1 &&
        execution.attempts === 0)
    ) {
      if (input.automatic) return null;
      const pending = await getDb(tx).execute<{ pending: boolean }>(sql`SELECT (
        EXISTS (SELECT 1 FROM "AiEvaluation" e WHERE e.state IN (${aiEvaluationState.enum.queued},${aiEvaluationState.enum.result_ready})
          AND e.receipt->>'retryEvaluationId' IS NULL
          AND (e."runId"=${input.runId}::uuid OR EXISTS (SELECT 1 FROM "AiEvaluationRequest" r WHERE r."evaluationId"=e.id AND r."runId"=${input.runId}::uuid AND r."cancelledAt" IS NULL)))
        OR EXISTS (SELECT 1 FROM "RunStep" s WHERE s."runId"=${input.runId}::uuid AND s.state=${runStepState.enum.queued})
      ) AS pending`);
      // A completed transport Job can leave a failed discovery's frozen page owed.
      const retainedDiscoveryPage =
        owner.purpose === "mail_discovery" &&
        owner.status === "failed" &&
        mailboxDiscoveryProgress.safeParse(owner.progress).data?.page !==
          undefined;
      if (!pending.rows[0]?.pending && !retainedDiscoveryPage)
        throw new Error("Completed Run cannot be relaunched; create a new Run");
      execution = await enqueueJob(tx, {
        key: execution.key,
        kind: execution.kind,
        input: execution.input,
        runId: input.runId,
        priority,
        invalidate: true,
      });
    }
    if (!input.automatic && execution.priority < priority) {
      const raised = await prioritizeJob(tx, execution.id, priority);
      if (raised) execution = raised;
    }
    await getDb(tx)
      .update(runTable)
      .set({
        status: admitted ? "running" : "paused",
        endedAt: null,
        failureCode: admitted ? null : MAIL_DISCOVERY_ADMISSION_WAIT,
        dispatchError: admitted
          ? null
          : "Mail discovery is queued for shared search capacity",
        progress: sql`(coalesce(${runTable.progress}, '{}'::jsonb) - 'fundingReleasedAt' - 'admissionRequestedAt') || ${JSON.stringify(admissionProgress)}::jsonb || jsonb_build_object('attempt', ${execution.generation}::int)`,
      })
      .where(eq(runTable.id, input.runId));
    if (!input.automatic) {
      // An explicit launch releases the retained Job's backoff without resetting
      // its attempt, cursor or the funding preflights on the next page.
      await makeJobsDueNow(tx, sql`SELECT ${execution.key}::text`);
      // Items parked while this Run was stopped return at its priority.
      const pending = await getDb(tx).execute<{
        id: string;
      }>(sql`SELECT e.id FROM "AiEvaluation" e
        WHERE e.state IN (${aiEvaluationState.enum.queued},${aiEvaluationState.enum.result_ready})
          AND (e."runId"=${input.runId}::uuid OR EXISTS (SELECT 1 FROM "AiEvaluationRequest" r WHERE r."evaluationId"=e.id AND r."runId"=${input.runId}::uuid AND r."cancelledAt" IS NULL))`);
      const { markAiEvaluationWork } =
        await import("~/server/ai/evaluation/repo/ai-evaluation-work");
      await markAiEvaluationWork(
        tx,
        pending.rows.map((row) => row.id),
        { revive: true },
      );
    }
    await runAfterCommit(tx, async () => {
      await (
        await import("../background-tasks/publish")
      ).wakeJobs({ source: "run-launch" });
    });
    return { attempt: execution.generation, instanceId: execution.id };
  }).catch((error: unknown) => {
    if (input.purpose === "mail_discovery") {
      const deferred = mailDiscoveryBackpressure(error);
      if (deferred) throw deferred;
    }
    const pg = findPgError(error);
    if (
      !input.automatic &&
      pg?.code === "23505" &&
      pg.constraint?.startsWith("Run_one_active_")
    )
      throw createAppError(
        "RUN_CONTROL_REFUSED",
        "Another active Run owns this admission slot; retry after it finishes",
        error,
      );
    throw error;
  });
}

function currentRunClaim(params: WorkflowRunParams) {
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
  return current.claim.generation === params.attempt ? current : null;
}

/** Yield only before new domain work, never while a provider request is in flight. */
export async function yieldClaimedMailDiscovery(
  db: Database,
  params: WorkflowRunParams,
): Promise<void> {
  if (!currentRunClaim(params)) return;
  const runId = runEntityId.parse(params.runId);
  const yielded = await withTransactionDatabase(db, async (tx) => {
    const mailbox = await lockMailDiscoveryRunAdmission(tx, runId);
    if (!mailbox) return false;
    const [owner] = await getDb(tx)
      .select()
      .from(runTable)
      .where(eq(runTable.id, runId))
      .for("update");
    const successor = related(runTable, (next) =>
      eq(next.predecessorRunId, outer(runTable.id)),
    ).exists();
    if (
      !owner ||
      owner.status !== "running" ||
      owner.deletedAt ||
      owner.retiredAt
    )
      return false;
    const input = mailboxDiscoveryInput.parse(owner.input);
    const progress = mailboxDiscoveryProgress.parse(owner.progress);
    if (
      owner.ledgerPartyId !== mailbox.ledgerPartyId ||
      input.mailboxId !== mailbox.mailboxId
    )
      throw new Error("Mail discovery admission identity changed");
    if (
      progress.attempt !== params.attempt ||
      !(await mailDiscoveryShouldYield(tx, {
        ...mailbox,
        runId,
        controlled: Boolean(input.controlled),
        progress,
      }))
    )
      return false;
    const [queued] = await getDb(tx)
      .update(runTable)
      .set({
        status: "paused",
        failureCode: MAIL_DISCOVERY_ADMISSION_WAIT,
        dispatchError: "Mail discovery is queued for shared search capacity",
        progress: sql`${runTable.progress} || jsonb_build_object('admissionRequestedAt', ${new Date().toISOString()}::text)`,
      })
      .where(and(eq(runTable.id, runId), not(successor)))
      .returning({ id: runTable.id });
    // A concurrent stop, lease loss or new generation rolls back the yield.
    if (queued) await assertWorkflowEffect(tx);
    return Boolean(queued);
  }).catch((error: unknown) => {
    throw mailDiscoveryBackpressure(error) ?? error;
  });
  if (yielded)
    throw new JobDeferredError(
      "Mail discovery yielded shared search capacity",
      new Date(Date.now() + 15_000),
      "provider_capacity",
    );
}

/** A recovered universal Job restores only its own reconciled failure, under its fence. */
export async function resumeClaimedWorkflowRun(
  db: Database,
  params: WorkflowRunParams,
  reason: "job_failed" | "funding_ready" | "mail_admission" = "job_failed",
): Promise<void> {
  const current = currentRunClaim(params);
  if (
    !current ||
    (reason === "job_failed" &&
      current.claim.generation === 1 &&
      current.claim.attempts === 0)
  )
    return;
  const runId = runEntityId.parse(params.runId);
  try {
    const waiting = await withTransactionDatabase(db, async (tx) => {
      const mailbox = await lockMailDiscoveryRunAdmission(tx, runId);
      const [mailOwner] = mailbox
        ? await getDb(tx)
            .select()
            .from(runTable)
            .where(eq(runTable.id, runId))
            .for("update")
        : [];
      if (
        mailOwner &&
        mailbox &&
        (mailOwner.ledgerPartyId !== mailbox.ledgerPartyId ||
          mailboxDiscoveryInput.parse(mailOwner.input).mailboxId !==
            mailbox.mailboxId)
      )
        throw new Error("Mail discovery admission identity changed");
      const scope = mailOwner
        ? retainedMailDiscoveryScope(mailOwner)
        : undefined;
      const recovery =
        reason !== "mail_admission" ||
        mailboxDiscoveryProgress.safeParse(mailOwner?.progress).data
          ?.admissionClass !== "automatic";
      const successor = related(runTable, (next) =>
        eq(next.predecessorRunId, outer(runTable.id)),
      ).exists();
      const eligible =
        mailOwner &&
        !mailOwner.deletedAt &&
        !mailOwner.retiredAt &&
        (reason === "mail_admission"
          ? mailOwner.status === "paused" &&
            mailOwner.failureCode === MAIL_DISCOVERY_ADMISSION_WAIT
          : reason === "funding_ready"
            ? mailOwner.status === "paused_auth" &&
              mailOwner.failureCode === "execution_limit"
            : mailOwner.status === "failed" &&
              mailOwner.failureCode === "job_failed");
      if (
        eligible &&
        mailbox &&
        scope &&
        (await mailDiscoveryAdmission(tx, {
          ...mailbox,
          scope,
          runId: runId,
          recovery,
        })) !== "available"
      ) {
        const [queued] = await getDb(tx)
          .update(runTable)
          .set({
            status: "paused",
            failureCode: MAIL_DISCOVERY_ADMISSION_WAIT,
            dispatchError:
              "Mail discovery is queued for shared search capacity",
            progress: sql`coalesce(${runTable.progress}, '{}'::jsonb) || ${JSON.stringify(
              {
                discoveryScope: scope,
                admissionClass: recovery ? "recovery" : "automatic",
                admissionRequestedAt:
                  mailboxDiscoveryProgress.parse(mailOwner.progress)
                    .admissionRequestedAt ?? new Date().toISOString(),
              },
            )}::jsonb`,
          })
          .where(
            and(
              eq(runTable.id, runId),
              isNull(runTable.deletedAt),
              isNull(runTable.retiredAt),
              not(successor),
            ),
          )
          .returning({ id: runTable.id });
        if (queued) await assertWorkflowEffect(tx);
        return Boolean(queued);
      }

      const [resumed] = await getDb(tx)
        .update(runTable)
        .set({
          status: "running",
          endedAt: null,
          failureCode: null,
          dispatchError: null,
          progress: sql`(coalesce(${runTable.progress}, '{}'::jsonb) - 'fundingReleasedAt' - 'admissionRequestedAt') || ${JSON.stringify(scope ? { discoveryScope: scope, admissionClass: recovery ? "recovery" : "automatic" } : {})}::jsonb || jsonb_build_object('attempt', ${current.claim.generation}::int)`,
        })
        .where(
          and(
            eq(runTable.id, runId),
            eq(
              runTable.status,
              reason === "funding_ready"
                ? "paused_auth"
                : reason === "mail_admission"
                  ? "paused"
                  : "failed",
            ),
            eq(
              runTable.failureCode,
              reason === "funding_ready"
                ? "execution_limit"
                : reason === "mail_admission"
                  ? MAIL_DISCOVERY_ADMISSION_WAIT
                  : "job_failed",
            ),
            isNull(runTable.deletedAt),
            isNull(runTable.retiredAt),
            not(successor),
          ),
        )
        .returning({ id: runTable.id });
      // Run-before-Job ordering matches launch/control. A member stop or stale
      // generation rolls the restoration back before any domain work can run.
      if (resumed) await assertWorkflowEffect(tx);
      return false;
    });
    if (waiting)
      throw new JobDeferredError(
        "Mail discovery is queued for shared search capacity",
        new Date(Date.now() + 15_000),
        "provider_capacity",
      );
  } catch (error) {
    const claimInput = current.claim.input;
    if (
      claimInput !== null &&
      typeof claimInput === "object" &&
      "purpose" in claimInput &&
      claimInput.purpose === "mail_discovery"
    ) {
      const deferred = mailDiscoveryBackpressure(error);
      if (deferred) throw deferred;
    }
    const pg = findPgError(error);
    if (pg?.code === "23505" && pg.constraint?.startsWith("Run_one_active_"))
      throw new JobRetryableError(
        "Run recovery is waiting for another active Run",
        { cause: error },
      );
    throw error;
  }
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
  await assertWorkflowEffect(db);
  const current = currentRunClaim(params);
  if (!current) return null;
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
  await assertWorkflowEffect(db);
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

const reconcilable = () =>
  or(
    eq(runTable.status, "running"),
    and(
      eq(runTable.status, "paused_auth"),
      eq(runTable.failureCode, "execution_limit"),
    ),
  )!;

/** Permit selection: a stopped execution whose Run still reads as running. */
export const workflowRunsToReconcile = () =>
  stoppedRunExecutionsExist(reconcilable() ?? sql`false`);

/** Lost permits and interrupted workers are recovered by permit selection, never new Run attempts. */
export async function reconcileWorkflowRuns(
  db: Database,
  after: string | null = null,
) {
  const rows = await stoppedRunExecutions(db, reconcilable(), 100, after);
  let reconciled = 0;
  for (const row of rows) {
    if (!row.runId || !["failed", "cancelled", "paused"].includes(row.state))
      continue;
    const updated = await withTransactionDatabase(db, async (tx) => {
      // Match launch's Run-before-Job order without waiting on an active writer.
      const [owner] = await getDb(tx)
        .select({ id: runTable.id })
        .from(runTable)
        .where(and(eq(runTable.id, row.runId!), reconcilable()))
        .for("update", { skipLocked: true });
      if (!owner) return false;
      if (!(await lockUnchangedJob(tx, row))) return false;
      await getDb(tx)
        .update(runTable)
        .set({
          status: row.state === "paused" ? "paused" : "failed",
          endedAt: row.state === "paused" ? null : new Date(),
          dispatchError: row.error,
          failureCode:
            row.state === "cancelled"
              ? "user_cancelled"
              : row.state === "failed"
                ? "job_failed"
                : null,
        })
        .where(and(eq(runTable.id, row.runId!), reconcilable()));
      return true;
    });
    if (updated) reconciled++;
  }
  return { reconciled, next: rows.length === 100 ? rows.at(-1)!.id : null };
}
