import { buildActorContext } from "@cubby/schemas/context";
import {
  emailReclassifyResult,
  mailReclassificationCheckpoint,
} from "@cubby/schemas/email-actions";
import { runEntityId } from "@cubby/schemas/identifiers";
import {
  OWNED_AI_WORK_PURPOSES,
  suggestionSweepRunProgress,
} from "@cubby/schemas/run-fields";
import { z } from "zod";

import { findErrorCause } from "~/lib/error-diagnostics";
import { AiBudgetExhaustedError } from "~/server/ai/budget";
import { aiBudgetWindow } from "~/server/ai/budget-window";
import {
  aiEvaluationProgress,
  claimAiEvaluation,
} from "~/server/ai/repo/ai-evaluation";
import {
  requestedAiEvaluations,
  PENDING_AI_STATES,
} from "~/server/ai/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import {
  executeReclassificationTarget,
  type ReclassificationPorts,
} from "~/server/domains/purchase-import/service/gmail/reclassification-target";
import {
  aiEvaluationsForRun,
  readAiRefreshWorkSummary,
  guardAiEvaluationAttempt,
  pauseRunForAiWork,
  readAiEvaluation,
  readAiEvaluationReceipt,
  readRun,
  readRunStatus,
  recordAiEvaluationAttemptFailure,
  writeRunningAttemptProgress,
  type AiEvaluationRow,
  type RunRow,
} from "~/server/domains/run/repo/ai-work-state";
import { currentJobExecution } from "~/server/generic/jobs/context";
import { JobDeferredError, JobPausedError } from "~/server/generic/jobs/errors";
import { buildCrudServices } from "~/server/http/request-context";
import type { WorkflowRunParams } from "~/server/workflows/runs/contract";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";
import { claimWorkflowRun } from "~/server/workflows/runs/lifecycle";
import { runFailureText } from "~/server/workflows/runs/lifecycle";

import { executeAiRefreshTarget } from "./ai-refresh";
import {
  executeSuggestionSweepTarget,
  type SuggestionSweepPorts,
} from "./suggestion-sweep";

/** Kinds whose evaluations name the Run as owner rather than requesting shared work. */
const ownsAiWork = (owner: Pick<RunRow, "purpose">) =>
  OWNED_AI_WORK_PURPOSES.some((purpose) => purpose === owner.purpose);

export type AiWorkPorts = {
  reclassification?: ReclassificationPorts;
  sweep?: SuggestionSweepPorts;
};

/** The real driver and deterministic boundary tests use the same checkpoint/finalization transition. */
export async function advanceAiWorkRun(
  db: Database,
  params: WorkflowRunParams,
  ports: Pick<AiWorkPorts, "sweep"> = {},
) {
  const owner = await claimWorkflowRun(db, params);
  if (!owner) return null;
  if (
    owner.purpose === "suggestion_sweep" &&
    !z.object({ rosterPrepared: z.literal(true) }).safeParse(owner.progress)
      .success
  ) {
    await (
      await import("./suggestion-sweep")
    ).prepareSuggestionSweep(db, owner.id, {
      ...ports.sweep,
      context: ports.sweep?.context ?? {
        ...buildCrudServices(db),
        actorContext: buildActorContext(owner.actorUserId, owner.channel, {
          oauthClientId: owner.oauthClientId,
          deviceId: owner.deviceId,
          runId: owner.id,
        }),
      },
    });
    // Preparation preserves the current Job generation.
    const prepared = await readRun(db, owner.id);
    if (!prepared) return null;
    Object.assign(owner, prepared);
  }
  if (owner.purpose === "ai_refresh") {
    const summary = await readAiRefreshWorkSummary(
      db,
      owner.id,
      params.attempt,
    );
    const complete = summary.pending.length === 0;
    const failed = summary.progress.failed > 0;
    const written = await writeRunningAttemptProgress(
      db,
      owner.id,
      params.attempt,
      {
        progress: { ...summary.progress },
        ...(complete
          ? {
              status: failed ? "failed" : "completed",
              endedAt: new Date(),
              failureCode: failed ? "ai_work_failed" : null,
              dispatchError: summary.failureText,
            }
          : {}),
      },
      { requireNoOwnedPendingWork: complete },
    );
    if (complete && !written) return advanceAiWorkRun(db, params, ports);
    return summary.pending;
  }
  const items = await aiWorkItems(db, owner);
  if (owner.purpose === "mail_reclassify" && !items.length)
    throw new Error(
      "Manual Reclassify has no durable roster; retain its evidence for historical recovery.",
    );
  const pending = items.filter((item) =>
    PENDING_AI_STATES.includes(item.state),
  );
  const progress = aiWorkProgress(
    owner,
    items,
    params.attempt,
    pending.length === 0,
  );
  const failed = items.some((item) => item.state === "failed");
  const written = await writeRunningAttemptProgress(
    db,
    owner.id,
    params.attempt,
    {
      progress,
      ...(pending.length
        ? {}
        : {
            status: failed ? "failed" : "completed",
            endedAt: new Date(),
            failureCode: failed ? "ai_work_failed" : null,
            dispatchError:
              items
                .flatMap((item) => (item.error ? [item.error] : []))
                .join("\n") || null,
          }),
    },
    {
      requireNoOwnedPendingWork: !pending.length && ownsAiWork(owner),
    },
  );
  // Work joined this Run after its roster read: continue with it instead of settling.
  if (!pending.length && !written && ownsAiWork(owner))
    return advanceAiWorkRun(db, params, ports);
  return pending
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, 2);
}
export async function aiWorkItems(db: Database, owner: RunRow) {
  const items = await (ownsAiWork(owner)
    ? aiEvaluationsForRun(db, owner.id)
    : requestedAiEvaluations(db, owner.id));
  return items.filter(
    (item) =>
      !z.object({ retryEvaluationId: z.uuid() }).safeParse(item.receipt)
        .success,
  );
}

export async function executeAiWorkTarget(
  db: Database,
  id: string,
  requestingRunId: string,
  ports: AiWorkPorts = {},
) {
  const read = await readAiEvaluation(db, id);
  if (!read) return false;
  if (read.executionKind === "ai_refresh")
    return executeAiRefreshTarget(db, id);
  const item = await claimAiEvaluation(db, id, requestingRunId);
  if (!item?.attemptToken) return false;
  try {
    await guardAiEvaluationAttempt(db, id, item.attemptToken);
    if (item.executionKind === "mail_reclassify")
      await executeReclassificationTarget(db, item, ports.reclassification);
    else {
      const owner = await readRun(db, item.runId);
      if (!owner) throw new Error("Suggestion sweep Run no longer exists");
      const context = ports.sweep?.context ?? {
        ...buildCrudServices(db),
        actorContext: buildActorContext(owner.actorUserId, owner.channel, {
          oauthClientId: owner.oauthClientId,
          deviceId: owner.deviceId,
          runId: owner.id,
        }),
      };
      await executeSuggestionSweepTarget(db, item, { ...ports.sweep, context });
    }
  } catch (error) {
    const deferred = findErrorCause(
      error,
      (cause): cause is JobDeferredError => cause instanceof JobDeferredError,
    );
    if (deferred) throw deferred;
    const message = runFailureText(
      error instanceof Error ? error : String(error),
    );
    const budget = findErrorCause(
      error,
      (cause): cause is AiBudgetExhaustedError =>
        cause instanceof AiBudgetExhaustedError,
    );
    const unauthorized = Boolean(budget) || /mailbox.*connected/i.test(message);
    const paused = (await readRunStatus(db, item.runId)) === "paused";
    const fenced = /attempt is obsolete|generation or Run is obsolete/.test(
      message,
    );
    const waiting =
      unauthorized ||
      paused ||
      fenced ||
      message.includes("AI Gateway admission is waiting");
    const obsolete =
      !fenced && /changed during inference|no longer exists/.test(message);
    await recordAiEvaluationAttemptFailure(
      db,
      { id, attemptToken: item.attemptToken },
      {
        state:
          obsolete && !paused
            ? "obsolete"
            : !waiting &&
                item.attempts >= (currentJobExecution()?.claim.maxAttempts ?? 3)
              ? "failed"
              : "retry_wait",
        error: message,
      },
    );
    if (paused) throw new JobPausedError("AI work paused by its requester");
    if (budget)
      throw new JobDeferredError(
        message,
        new Date(budget.resumeAt),
        "ai_funding_window",
      );
    if (unauthorized) {
      await pauseRunForAiWork(db, item.runId, message);
      throw new JobPausedError(message);
    }
    if (message.includes("AI Gateway admission is waiting"))
      throw new JobDeferredError(
        message,
        new Date(Date.now() + 30_000),
        "rate_limit",
      );
    if (!obsolete) throw error;
  }
  const continuations = z
    .object({ continuationRunIds: z.array(z.uuid()) })
    .safeParse(await readAiEvaluationReceipt(db, id));
  if (continuations.success)
    for (const next of continuations.data.continuationRunIds)
      await launchWorkflowRun(db, {
        runId: runEntityId.parse(next),
        purpose: "mail_reclassify",
        automatic: true,
      });
  return true;
}

function aiWorkProgress(
  owner: RunRow,
  items: readonly AiEvaluationRow[],
  attempt: number,
  complete = false,
) {
  if (ownsAiWork(owner))
    return {
      ...aiEvaluationProgress(items, attempt),
    };
  if (owner.purpose === "mail_reclassify") {
    const results = items.flatMap((item) => {
      const receipt = z
        .object({ result: emailReclassifyResult })
        .safeParse(item.receipt);
      if (receipt.success) return [receipt.data.result];
      if (!["failed", "obsolete", "cancelled"].includes(item.state)) return [];
      const snapshot = z
        .object({ publicId: emailReclassifyResult.shape.id })
        .safeParse(item.snapshot);
      return snapshot.success
        ? [
            emailReclassifyResult.parse({
              id: snapshot.data.publicId,
              outcome:
                item.state === "failed"
                  ? "failed"
                  : item.state === "cancelled"
                    ? "cancelled"
                    : "changed",
              classification: null,
              stage: null,
              conflict: false,
              error: item.error,
            }),
          ]
        : [];
    });
    return mailReclassificationCheckpoint.parse({
      kind: "mail_reclassification",
      version: 1,
      attempt,
      complete,
      results,
    });
  }
  const legacy = suggestionSweepRunProgress.safeParse(owner.progress).data
    ?.legacyCounts;
  const receipts = items.map((item) =>
    z
      .object({
        outcome: z.string(),
        diagnostics: suggestionSweepRunProgress.shape.diagnostics.optional(),
      })
      .safeParse(item.receipt),
  );
  return {
    ...suggestionSweepRunProgress.parse({
      total: items.length,
      done: items.filter((item) => !PENDING_AI_STATES.includes(item.state))
        .length,
      applied:
        (legacy?.applied ?? 0) +
        receipts.filter(
          (receipt) => receipt.success && receipt.data.outcome === "applied",
        ).length,
      queued:
        (legacy?.queued ?? 0) +
        receipts.filter(
          (receipt) => receipt.success && receipt.data.outcome === "queued",
        ).length,
      failed:
        (legacy?.failed ?? 0) +
        items.filter((item) => item.state === "failed").length,
      diagnostics: receipts.flatMap((receipt) =>
        receipt.success ? (receipt.data.diagnostics ?? []) : [],
      ),
    }),
    ...(legacy ? { legacyCounts: legacy } : {}),
    rosterPrepared: true,
    attempt,
  };
}

/** A member-raised budget may wake queued work earlier; exhausted or controlled Jobs stay stopped. */
export async function resumeFundingPausedRuns(
  db: Database,
  {
    now = new Date(),
    anyWindow = false,
  }: { now?: Date; anyWindow?: boolean } = {},
) {
  const imports = await (
    await import("~/server/domains/purchase-import/repo/run-service")
  ).redispatchBudgetPausedImports(
    db,
    now,
    anyWindow ? now : aiBudgetWindow(now).start,
  );
  const moved = anyWindow
    ? await (
        await import("~/server/generic/jobs/repo/jobs")
      ).bringQueuedJobsForward(db, now)
    : [];
  await (
    await import("~/server/workflows/background-tasks/publish")
  ).wakeJobs({ source: "funding-window" });
  return imports + moved.length;
}
