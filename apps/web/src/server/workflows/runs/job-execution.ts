import { runEntityId, type RunId } from "@cubby/schemas/identifiers";
import {
  mailboxDiscoveryProgress,
  MAIL_DISCOVERY_ADMISSION_WAIT,
} from "@cubby/schemas/mailbox-research";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { findErrorCause } from "~/lib/error-diagnostics";
import { findFundingWait } from "~/server/ai/budget";
import { GatewayProviderStopError } from "~/server/ai/gateway-egress-client";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/retained-tables";
import { readRun } from "~/server/domains/run/repo/ai-work-state";
import { pendingFundingResumeAt } from "~/server/domains/run/repo/execution-context";
import { JobDeferredError } from "~/server/generic/jobs/errors";
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
  purpose: z.literal("mail_discovery"),
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
 * Mail discovery still pages as a `run.execute` Job; step-ledger and AI-work
 * Runs run as the `run.execute` Pass (`run-pass.ts`). The discovery cursor is
 * the Job cursor; the Job owns admission, waits and retries.
 */
export const runJobHandler = defineJobHandler(
  runJobInput,
  async (db, claim, input, context): Promise<PreparedJobPage> => {
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
        const discovery = before?.purpose === input.purpose;
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
          const pending = await pendingFundingResumeAt(db);
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
        return {
          page: await (
            await import("~/server/domains/purchase-import/operations/gmail/discovery")
          ).advanceMailDiscoveryPage(db, params, claim.cursor),
        };
      },
    ).catch(async (error: unknown) => {
      const funding = findFundingWait(error);
      if (funding)
        return fundingWait(
          input.runId,
          claim.cursor,
          funding.until,
          error instanceof Error ? error.message : funding.message,
          error,
        );
      const provider = findErrorCause(
        error,
        (cause): cause is GatewayProviderStopError =>
          cause instanceof GatewayProviderStopError,
      );
      const wait = funding ?? provider;
      const deferred = wait
        ? new JobDeferredError(
            error instanceof Error ? error.message : wait.message,
            wait.until,
            wait.reason,
          )
        : mailDiscoveryBackpressure(error);
      if (!deferred) throw error;
      // A provider stop names itself on the Run; a budget stop already paused it.
      if (provider && wait === provider)
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
