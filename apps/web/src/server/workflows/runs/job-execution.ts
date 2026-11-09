import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import { jobWaitReason } from "@cubby/schemas/job";
import {
  mailboxDiscoveryProgress,
  MAIL_DISCOVERY_ADMISSION_WAIT,
} from "@cubby/schemas/mailbox-research";
import { RUN_KINDS, EXECUTED_RUN_PURPOSES } from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { findErrorCause } from "~/lib/error-diagnostics";
import { AiBudgetExhaustedError } from "~/server/ai/budget";
import { GatewayProviderStopError } from "~/server/ai/gateway-egress-client";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/retained-tables";
import { readRun } from "~/server/domains/run/repo/ai-work-state";
import {
  fundingResumeAt,
  fundingResumeInput,
} from "~/server/domains/run/repo/execution-context";
import { JobPausedError, JobDeferredError } from "~/server/generic/jobs/errors";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";
import type { PreparedJobPage } from "~/server/generic/jobs/types";
import { withWorkflowExecution } from "~/server/workflows/runs/execution";
import {
  mailDiscoveryBackpressure,
  resumeClaimedWorkflowRun,
  yieldClaimedMailDiscovery,
} from "~/server/workflows/runs/lifecycle";

const runJobInput = z.object({
  runId: runEntityId,
  purpose: z.enum(EXECUTED_RUN_PURPOSES),
});
const fundingRelease = mailboxDiscoveryProgress.pick({
  fundingReleasedAt: true,
});

function fundingWait(
  runId: RunId,
  cursor: PreparedJobPage["page"]["cursor"],
  until: Date,
  message: string,
  cause?: unknown,
): PreparedJobPage {
  return {
    page: {
      done: false,
      ...(cursor === null ? {} : { cursor }),
      waitUntil: until,
      waitReason: "ai_funding_window",
    },
    publish: async (tx) => {
      // Release locks this Run before moving queued Jobs forward. Holding it
      // through publication prevents an old timer from overwriting that wake.
      const [owner] = await getDb(tx)
        .select({ progress: run.progress })
        .from(run)
        .where(eq(run.id, runId))
        .for("share");
      if (fundingRelease.safeParse(owner?.progress).data?.fundingReleasedAt) {
        const due = new JobDeferredError(
          message,
          new Date(),
          "ai_funding_window",
        );
        due.cause = cause;
        throw due;
      }
    },
  };
}

/**
 * One handler executes every kind its manifest entry gives an `execution`:
 * a RunStep ledger, AI work coordination, or mailbox discovery. RunStep
 * cursors and receipts remain domain checkpoints; only Job owns admission and
 * retries. AI evaluations themselves run in the `ai.evaluation` drain.
 */
export const runJobHandler = defineJobHandler(
  runJobInput,
  async (db, claim, input, context): Promise<PreparedJobPage> => {
    const execution = RUN_KINDS[input.purpose].execution;
    return withWorkflowExecution(
      {
        runId: input.runId,
        attempt: claim.generation,
        database: db,
        job: context,
      },
      async (): Promise<PreparedJobPage> => {
        const params = { runId: input.runId, attempt: claim.generation };
        const before = await readRun(db, input.runId);
        const discovery =
          before?.purpose === input.purpose && execution === "mail_discovery";
        // A restored owner gets one durable quantum before renewing admission.
        if (discovery && before.status === "running")
          await yieldClaimedMailDiscovery(db, params);
        if (
          discovery &&
          before.status === "paused" &&
          before.failureCode === MAIL_DISCOVERY_ADMISSION_WAIT
        )
          await resumeClaimedWorkflowRun(db, params, "mail_admission");
        if (before?.status === "failed" && before.failureCode === "job_failed")
          await resumeClaimedWorkflowRun(db, params);
        if (
          before?.status === "paused_auth" &&
          before.failureCode === "execution_limit"
        ) {
          // Generic retry-now can advance this Job, but only the funding owner
          // or an explicit Run launch may lift a still-pending funding pause.
          const pending = (
            await readJobs(
              db,
              {
                kind: "run.funding-resume",
                states: ["queued", "retry_wait", "running"],
              },
              { order: ["availableAt"] },
            )
          )
            .map((job) => new Date(fundingResumeInput.parse(job.input).until))
            .filter((until) => until > new Date())
            .sort((left, right) => left.getTime() - right.getTime())[0];
          if (
            pending &&
            !fundingRelease.safeParse(before.progress).data?.fundingReleasedAt
          )
            return fundingWait(
              input.runId,
              claim.cursor,
              pending,
              before.dispatchError ?? "Run awaits its funding window",
            );
          await resumeClaimedWorkflowRun(db, params, "funding_ready");
        }
        if (execution === "steps") {
          const next = await (
            await import("~/server/domains/run/service/step-run")
          ).advanceStepRun(db, params);
          if (next.kind === "finished" || next.kind === "lost")
            return { page: { done: true } };
          if (next.kind === "paused") {
            const steps = await (
              await import("~/server/domains/run/repo/run-step")
            ).listRunSteps(db, input.runId);
            const paused = steps.find((step) => step.state === "paused");
            if (paused?.pausedUntil)
              throw new JobDeferredError(
                paused.pausedReason ?? "Step capacity wait",
                paused.pausedUntil,
                next.waitReason ?? "provider_capacity",
              );
            throw new JobPausedError(
              paused?.pausedReason ?? "Step requires member attention",
            );
          }
          const seconds = next.waitSeconds ?? 0;
          const availableAt = new Date(Date.now() + seconds * 1000);
          return {
            page: {
              done: false,
              availableAt,
              ...(seconds > 0
                ? {
                    waitUntil: availableAt,
                    waitReason: jobWaitReason.enum.provider_capacity,
                  }
                : {}),
            },
          };
        }
        if (execution === "mail_discovery")
          return {
            page: await (
              await import("~/server/domains/purchase-import/operations/gmail/discovery")
            ).advanceMailDiscoveryPage(db, params, claim.cursor),
          };
        const pending = await (
          await import("~/server/domains/run/service/ai-work")
        ).advanceAiWorkRun(db, params);
        // Evaluation settlement wakes this Job (`wakeAiEvaluationRequesters`);
        // the interval only recovers a lost wake.
        return {
          page: {
            done: !pending,
            availableAt: new Date(Date.now() + 60_000),
          },
        };
      },
    ).catch(async (error: unknown) => {
      const budget = findErrorCause(
        error,
        (cause): cause is AiBudgetExhaustedError =>
          cause instanceof AiBudgetExhaustedError,
      );
      const provider = findErrorCause(
        error,
        (cause): cause is GatewayProviderStopError =>
          cause instanceof GatewayProviderStopError,
      );
      if (budget && execution === "mail_discovery")
        return fundingWait(
          input.runId,
          claim.cursor,
          fundingResumeAt(budget.status.windowEnd),
          error instanceof Error ? error.message : budget.message,
          error,
        );
      const deferred = budget
        ? new JobDeferredError(
            error instanceof Error ? error.message : budget.message,
            fundingResumeAt(budget.status.windowEnd),
            "ai_funding_window",
          )
        : provider
          ? new JobDeferredError(
              error instanceof Error ? error.message : provider.message,
              new Date(provider.retryAt),
              "provider_capacity",
            )
          : execution === "mail_discovery"
            ? mailDiscoveryBackpressure(error)
            : undefined;
      if (!deferred) throw error;
      if (provider && !budget)
        await context.fenced(async (tx) => {
          await getDb(tx)
            .update(run)
            .set({ dispatchError: deferred.message })
            .where(and(eq(run.id, input.runId), eq(run.status, "running")));
        });
      // Keep the typed provider cause and raw gateway diagnostic at this seam.
      deferred.cause = error;
      throw deferred;
    });
  },
);
