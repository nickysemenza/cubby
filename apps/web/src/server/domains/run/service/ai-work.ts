import { aiRefreshProgress } from "@cubby/schemas/ai-evaluation";
import { buildActorContext } from "@cubby/schemas/context";
import {
  emailReclassifyResult,
  mailReclassificationCheckpoint,
} from "@cubby/schemas/email-actions";
import { runEntityId } from "@cubby/schemas/identifiers";
import {
  OWNED_AI_WORK_PURPOSES,
  RUN_KINDS,
  type RunKindDeclaration,
} from "@cubby/schemas/run-fields";
import { z } from "zod";

import { aiBudgetWindow } from "~/server/ai/budget-window";
import type { ClaimedAiEvaluation } from "~/server/ai/evaluation/repo/ai-evaluation";
import {
  requestedAiEvaluations,
  PENDING_AI_STATES,
} from "~/server/ai/evaluation/repo/ai-evaluation-requests";
import {
  readEvaluationErrorText,
  readEvaluationTally,
  readFirstEvaluationErrors,
  type EvaluationScope,
} from "~/server/ai/evaluation/repo/evaluation-tally";
import type { Database } from "~/server/db";
import {
  executeReclassificationTarget,
  type ReclassificationPorts,
} from "~/server/domains/purchase-import/service/gmail/reclassification-target";
import {
  aiEvaluationsForRun,
  readAiRefreshWorkSummary,
  guardAiEvaluationAttempt,
  readAiEvaluationReceipt,
  readRun,
  writeRunningAttemptProgress,
  type AiEvaluationRow,
  type RunRow,
} from "~/server/domains/run/repo/ai-work-state";
import { JobEvidenceObsoleteError } from "~/server/generic/jobs/errors";
import { buildCrudServices } from "~/server/http/request-context";
import type { WorkflowRunParams } from "~/server/workflows/runs/contract";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";
import { claimWorkflowRun } from "~/server/workflows/runs/lifecycle";

import {
  executeSuggestionSweepTarget,
  type SuggestionSweepPorts,
} from "./suggestion-sweep";

/** How this Run's declared kind reads AI-work progress; undefined outside `ai_work`. */
const aiWorkProgressOf = (owner: Pick<RunRow, "purpose">) => {
  const kind: RunKindDeclaration = RUN_KINDS[owner.purpose];
  return kind.aiWorkProgress;
};

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
) {
  const owner = await claimWorkflowRun(db, params);
  if (!owner) return null;
  if (aiWorkProgressOf(owner) === "refresh") {
    const summary = await readAiRefreshWorkSummary(
      db,
      owner.id,
      params.attempt,
    );
    // An empty retained roster cannot establish that the original scope finished.
    if (!summary.hasRoster)
      throw new Error(
        "AI refresh has no durable evaluation roster; refusing to complete an unknown scope.",
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
    if (complete && !written) return advanceAiWorkRun(db, params);
    return summary.pending.length;
  }
  const work = await readAiWork(db, owner, params.attempt);
  if (aiWorkProgressOf(owner) === "reclassification" && !work.total)
    throw new Error(
      "Manual Reclassify has no durable roster; retain its evidence for historical recovery.",
    );
  const written = await writeRunningAttemptProgress(
    db,
    owner.id,
    params.attempt,
    {
      progress: work.progress,
      ...(work.pending
        ? {}
        : {
            status: work.failed ? "failed" : "completed",
            endedAt: new Date(),
            failureCode: work.failed ? "ai_work_failed" : null,
            dispatchError: await work.errorText(),
          }),
    },
    {
      requireNoOwnedPendingWork: !work.pending && ownsAiWork(owner),
    },
  );
  // Work joined this Run after its roster read: continue with it instead of settling.
  if (!work.pending && !written && ownsAiWork(owner))
    return advanceAiWorkRun(db, params);
  return work.pending;
}

/** What a Run's evaluations add up to, read in SQL unless its checkpoint needs each one. */
async function readAiWork(db: Database, owner: RunRow, attempt: number) {
  if (aiWorkProgressOf(owner) === "reclassification") {
    // A reclassify checkpoint records a result per Email, so it reads its roster.
    const items = await aiWorkItems(db, owner);
    const pending = items.filter((item) =>
      PENDING_AI_STATES.includes(item.state),
    ).length;
    return {
      total: items.length,
      pending,
      failed: items.some((item) => item.state === "failed"),
      progress: reclassificationProgress(items, attempt, pending === 0),
      errorText: async () =>
        items.flatMap((item) => (item.error ? [item.error] : [])).join("\n") ||
        null,
    };
  }
  if (ownsAiWork(owner)) {
    const scope: EvaluationScope = { runId: owner.id, source: "owned" };
    const tally = await readEvaluationTally(db, scope);
    return {
      total: tally.total,
      pending: tally.pending,
      failed: tally.failed > 0,
      progress: aiRefreshProgress.parse({
        attempt,
        selected: tally.total,
        queued: tally.queued,
        resultReady: tally.resultReady,
        completed: tally.completed,
        blocked: tally.blocked,
        failed: tally.failed,
        obsolete: tally.obsolete,
        cancelled: tally.cancelled,
        errors: await readFirstEvaluationErrors(db, scope, 10),
      }),
      errorText: () => readEvaluationErrorText(db, scope),
    };
  }
  throw new Error(`Run ${owner.purpose} does not use the AI-work driver`);
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

/** Reclassification and suggestion sweep evaluate one claimed item; the drain owns failures. */
export async function executeAiWorkTarget(
  db: Database,
  item: ClaimedAiEvaluation,
  ports: AiWorkPorts = {},
) {
  await guardAiEvaluationAttempt(db, item.id, item.attemptToken);
  if (item.executionKind === "mail_reclassify")
    await executeReclassificationTarget(db, item, ports.reclassification);
  else {
    const owner = item.runId && (await readRun(db, item.runId));
    if (!owner)
      throw new JobEvidenceObsoleteError(
        "Suggestion sweep Run no longer exists",
      );
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
  const continuations = z
    .object({ continuationRunIds: z.array(z.uuid()) })
    .safeParse(await readAiEvaluationReceipt(db, item.id));
  if (continuations.success)
    for (const next of continuations.data.continuationRunIds)
      await launchWorkflowRun(db, {
        runId: runEntityId.parse(next),
        purpose: "mail_reclassify",
        automatic: true,
      });
}

function reclassificationProgress(
  items: readonly AiEvaluationRow[],
  attempt: number,
  complete: boolean,
) {
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

/** A member-raised budget may wake queued work earlier; exhausted or controlled Jobs stay stopped. */
export async function resumeFundingPausedRuns(
  db: Database,
  {
    now = new Date(),
    anyWindow = false,
  }: { now?: Date; anyWindow?: boolean } = {},
) {
  const imports = await (
    await import("~/server/domains/run/repo/run-control")
  ).redispatchBudgetPausedImports(
    db,
    now,
    anyWindow ? now : aiBudgetWindow(now).start,
  );
  const discoveries = anyWindow
    ? await (
        await import("~/server/domains/run/repo/execution-context")
      ).releaseFundingPausedDiscovery(db, now)
    : 0;
  const moved = anyWindow
    ? await (
        await import("~/server/generic/jobs/repo/operator")
      ).bringQueuedJobsForward(db, now)
    : [];
  await (
    await import("~/server/workflows/background-tasks/publish")
  ).wakeJobs({ source: "funding-window" });
  return imports + discoveries + moved.length;
}
