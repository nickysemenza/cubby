import { aiRefreshProgress } from "@cubby/schemas/ai-evaluation";
import { buildActorContext } from "@cubby/schemas/context";
import {
  emailReclassifyResult,
  mailReclassificationCheckpoint,
} from "@cubby/schemas/email-actions";
import { runEntityId } from "@cubby/schemas/identifiers";
import { suggestionSweepRunProgress } from "@cubby/schemas/run-fields";
import { workflowRecoveryProgress } from "@cubby/schemas/workflow-runs";
import { z } from "zod";

import { findErrorCause } from "~/lib/error-diagnostics";
import {
  aiEvaluationProgress,
  claimAiEvaluation,
} from "~/server/ai/repo/ai-evaluation";
import {
  requestedAiEvaluations,
  PENDING_AI_STATES,
} from "~/server/ai/repo/ai-evaluation-requests";
import type { Database } from "~/server/db";
import { reclassificationSnapshot } from "~/server/domains/purchase-import/repo/gmail/reclassification-work";
import {
  executeReclassificationTarget,
  type ReclassificationPorts,
} from "~/server/domains/purchase-import/service/gmail/reclassification-target";
import {
  aiEvaluationsForRun,
  completeRecoveredAiWorkRun,
  guardAiEvaluationAttempt,
  pauseRunForExecutionAuthorization,
  readAiEvaluation,
  readAiEvaluationReceipt,
  readRun,
  readRunStatus,
  recordAiEvaluationAttemptFailure,
  recoverableManualAiWorkRuns,
  writeRunningAttemptProgress,
  type AiEvaluationRow,
  type RunRow,
} from "~/server/domains/run/repo/ai-work-state";
import { ExecutionBudgetError } from "~/server/domains/run/repo/execution-authorization";
import { buildCrudServices } from "~/server/http/request-context";
import { isWorkflowRunPurpose } from "~/server/workflows/runs/contract";
import type { WorkflowRunParams } from "~/server/workflows/runs/contract";
import { workflowInstanceId } from "~/server/workflows/runs/contract";
import type { WorkflowLauncher } from "~/server/workflows/runs/launcher";
import {
  productionWorkflowLauncher,
  ENDED_INSTANCE_STATES,
} from "~/server/workflows/runs/launcher";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";
import { claimWorkflowRun } from "~/server/workflows/runs/lifecycle";
import {
  failWorkflowRun,
  runFailureText,
} from "~/server/workflows/runs/lifecycle";

import { executeAiRefreshTarget } from "./ai-refresh";
import {
  executeSuggestionSweepTarget,
  type SuggestionSweepPorts,
} from "./suggestion-sweep";

export type AiWorkPorts = {
  reclassification?: ReclassificationPorts;
  sweep?: SuggestionSweepPorts;
  launcher?: WorkflowLauncher;
};

/** The real driver and deterministic boundary tests use the same checkpoint/finalization transition. */
export async function advanceAiWorkRun(
  db: Database,
  params: WorkflowRunParams,
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
      context: {
        ...buildCrudServices(db),
        actorContext: buildActorContext(owner.actorUserId, owner.channel, {
          oauthClientId: owner.oauthClientId,
          deviceId: owner.deviceId,
          runId: owner.id,
        }),
      },
    });
    // Preparation preserves the active Workflow attempt.
    const prepared = await readRun(db, owner.id);
    if (!prepared) return null;
    Object.assign(owner, prepared);
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
  await writeRunningAttemptProgress(db, owner.id, params.attempt, {
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
  });
  return pending
    .sort(
      (a, b) =>
        (a.nextAttemptAt ?? a.deadlineAt ?? a.createdAt).getTime() -
        (b.nextAttemptAt ?? b.deadlineAt ?? b.createdAt).getTime(),
    )
    .slice(0, 2);
}
export async function aiWorkItems(db: Database, owner: RunRow) {
  const items = await (owner.purpose === "ai_refresh"
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
    const message = runFailureText(
      error instanceof Error ? error : String(error),
    );
    const budget = findErrorCause(
      error,
      (cause): cause is ExecutionBudgetError =>
        cause instanceof ExecutionBudgetError,
    );
    const unauthorized =
      Boolean(budget) ||
      /execution approval|execution authorization|approval.*(?:expired|revoked|budget)|mailbox.*connected/i.test(
        message,
      );
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
            : !waiting && item.attempts >= 3
              ? "failed"
              : "retry_wait",
        attempts: waiting ? item.attempts - 1 : item.attempts,
        error: message,
        nextAttemptAt: new Date(
          Date.now() + 60_000 * Math.max(1, item.attempts),
        ),
        ...(budget && item.executionKind === "mail_reclassify"
          ? { minimumBudgetMicroUSD: budget.minimumBudgetMicroUSD }
          : {}),
      },
    );
    if (unauthorized)
      await pauseRunForExecutionAuthorization(db, item.runId, message);
  }
  const continuations = z
    .object({ continuationRunIds: z.array(z.uuid()) })
    .safeParse(await readAiEvaluationReceipt(db, id));
  if (continuations.success)
    for (const next of continuations.data.continuationRunIds)
      await launchWorkflowRun(
        db,
        {
          runId: runEntityId.parse(next),
          purpose: "mail_reclassify",
          automatic: true,
        },
        ports.launcher,
      );
  return true;
}

function aiWorkProgress(
  owner: RunRow,
  items: readonly AiEvaluationRow[],
  attempt: number,
  complete = false,
) {
  const oldProgress = z
    .object({
      done: z.number().optional(),
      results: z.array(z.unknown()).optional(),
      completed: z.number().optional(),
    })
    .safeParse(owner.progress);
  const refreshProgress =
    owner.purpose === "ai_refresh"
      ? aiRefreshProgress.safeParse(owner.progress).data
      : undefined;
  const oldDone = refreshProgress
    ? refreshProgress.completed +
      refreshProgress.blocked +
      refreshProgress.failed +
      (refreshProgress.obsolete ?? 0) +
      (refreshProgress.cancelled ?? 0)
    : oldProgress.success
      ? (oldProgress.data.done ??
        oldProgress.data.results?.length ??
        oldProgress.data.completed ??
        0)
      : 0;
  const madeProgress =
    items.filter((item) => !PENDING_AI_STATES.includes(item.state)).length >
    oldDone;
  const automaticRecoveryFailures = madeProgress
    ? 0
    : (workflowRecoveryProgress.parse(owner.progress ?? {})
        .automaticRecoveryFailures ?? 0);
  if (owner.purpose === "ai_refresh")
    return {
      ...aiEvaluationProgress(items, attempt),
      automaticRecoveryFailures,
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
      automaticRecoveryFailures,
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
    automaticRecoveryFailures,
  };
}

/** Existing catch-up/nightly callers repair lost dispatch independently of refresh activation. */
export async function recoverManualAiWork(
  db: Database,
  launcher: WorkflowLauncher = productionWorkflowLauncher,
  runIds?: readonly string[],
) {
  if (!runIds)
    await (
      await import("./reclassification-recovery")
    ).recoverHistoricalReclassification(db);
  const candidates = await recoverableManualAiWorkRuns(db, runIds);
  for (const owner of candidates) {
    if (owner.status === "running") {
      const attempt = z
        .object({ attempt: z.number().default(0) })
        .parse(owner.progress ?? {}).attempt;
      if (attempt > 0 && isWorkflowRunPurpose(owner.purpose)) {
        const instance = await launcher.status(
          owner.purpose,
          workflowInstanceId(owner.shortcode, attempt),
        );
        if (!ENDED_INSTANCE_STATES.has(instance.state)) continue;
        await failWorkflowRun(
          db,
          { runId: owner.id, attempt },
          {
            failureCode: "workflow_instance_ended",
            message: `Workflow startup handoff ended (${instance.state})${instance.error ? `: ${instance.error}` : ""}`,
          },
        );
        const reconciled = await readRun(db, owner.id, { live: true });
        if (
          !reconciled ||
          reconciled.status !== "failed" ||
          reconciled.failureCode === "user_cancelled" ||
          z
            .object({ attempt: z.number().default(0) })
            .parse(reconciled.progress ?? {}).attempt !== attempt
        )
          continue;
        Object.assign(owner, reconciled);
      }
    }
    if (
      owner.purpose === "suggestion_sweep" &&
      !z.object({ rosterPrepared: z.literal(true) }).safeParse(owner.progress)
        .success
    ) {
      const { prepareSuggestionSweep } = await import("./suggestion-sweep");
      await prepareSuggestionSweep(db, owner.id, {
        context: {
          ...buildCrudServices(db),
          actorContext: buildActorContext(owner.actorUserId, owner.channel),
        },
      });
    }
    const items = await requestedAiEvaluations(db, owner.id, {
      currentOnly: true,
    });
    if (!items.some((item) => PENDING_AI_STATES.includes(item.state))) {
      if (
        (items.length || owner.purpose === "suggestion_sweep") &&
        !items.some((item) => item.state === "failed")
      ) {
        const attempt = z
          .object({ attempt: z.number().default(0) })
          .parse(owner.progress ?? {}).attempt;
        await completeRecoveredAiWorkRun(
          db,
          owner,
          attempt,
          aiWorkProgress(owner, items, attempt, true),
        );
      }
      continue;
    }
    if (owner.status === "paused_auth" && owner.purpose === "mail_reclassify") {
      const { mailboxApproval } =
        await import("~/server/domains/purchase-import/service/gmail/reclassify");
      const { mailReclassifyRunInput } =
        await import("@cubby/schemas/run-fields");
      const input = mailReclassifyRunInput.parse(owner.input);
      try {
        if (!owner.ledgerPartyId) continue;
        const minimumBudgetMicroUSD = Math.max(
          0,
          ...items
            .filter((item) => PENDING_AI_STATES.includes(item.state))
            .map(
              (item) =>
                reclassificationSnapshot.parse(item.snapshot)
                  .minimumBudgetMicroUSD ?? 0,
            ),
        );
        await mailboxApproval(
          db,
          { userId: owner.actorUserId, ledgerPartyId: owner.ledgerPartyId },
          input.mailboxId,
          { minimumBudgetMicroUSD, newest: true },
        );
      } catch {
        // SILENT: authority waits for a later approval wake; retained work stays paused.
        continue;
      }
    }
    if (isWorkflowRunPurpose(owner.purpose))
      await launchWorkflowRun(
        db,
        { runId: owner.id, purpose: owner.purpose, automatic: true },
        launcher,
      );
  }
}
