import { aiRefreshRunInput } from "@cubby/schemas/ai-evaluation";
import { runEntityId } from "@cubby/schemas/identifiers";
import { jobWaitReason } from "@cubby/schemas/job";
import { RUN_KINDS } from "@cubby/schemas/run-fields";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/retained-tables";
import { readRun } from "~/server/domains/run/repo/ai-work-state";
import { JobPausedError, JobDeferredError } from "~/server/generic/jobs/errors";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";
import type { PreparedJobPage } from "~/server/generic/jobs/types";
import { EXECUTED_RUN_PURPOSES } from "~/server/workflows/runs/contract";
import { withWorkflowExecution } from "~/server/workflows/runs/execution";

const runJobInput = z.object({
  runId: runEntityId,
  purpose: z.enum(EXECUTED_RUN_PURPOSES),
});
const mailCursor = z.object({
  phase: z.enum(["list", "save"]),
  index: z.number().int().nonnegative(),
  more: z.boolean().optional(),
});

/**
 * One handler executes every kind its manifest entry gives an `execution`:
 * a RunStep ledger, AI work coordination, or mailbox discovery. RunStep
 * cursors and receipts remain domain checkpoints; only Job owns admission and
 * retries. AI evaluations themselves run in the `ai.evaluation` drain.
 */
export const runJobHandler = defineJobHandler(
  runJobInput,
  async (db, claim, input): Promise<PreparedJobPage> =>
    withWorkflowExecution(
      { runId: input.runId, attempt: claim.generation, database: db },
      async (): Promise<PreparedJobPage> => {
        const params = { runId: input.runId, attempt: claim.generation };
        const before = await readRun(db, input.runId);
        if (
          before?.status === "paused_auth" &&
          before.failureCode === "execution_limit"
        )
          await getDb(db)
            .update(run)
            .set({ status: "running" })
            .where(eq(run.id, input.runId));
        const execution = RUN_KINDS[input.purpose].execution;
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
        if (execution === "mail_discovery") {
          const mail =
            await import("~/server/domains/purchase-import/operations/gmail/discovery");
          const resumed = await mail.beginMailDiscovery(db, params);
          if (resumed.kind === "stopped") {
            await assertNotPaused(db, input.runId);
            return { page: { done: true } };
          }
          const cursor = mailCursor.parse(
            claim.cursor ?? { phase: "list", index: resumed.index },
          );
          if (cursor.phase === "list") {
            const page = await mail.listMailDiscovery(db, params);
            if (page.kind === "stopped") {
              await assertNotPaused(db, input.runId);
              return { page: { done: true } };
            }
            return {
              page: {
                done: false,
                cursor: { phase: "save", index: cursor.index, more: page.more },
              },
            };
          }
          const saved = await mail.saveMailDiscoveryBatch(
            db,
            params,
            cursor.index,
          );
          if (saved.kind === "stopped") {
            await assertNotPaused(db, input.runId);
            return { page: { done: true } };
          }
          if (!cursor.more) {
            await mail.finishMailDiscovery(db, params);
            await mail.continueMailDiscovery(db, params);
            return { page: { done: true } };
          }
          return {
            page: {
              done: false,
              cursor: { phase: "list", index: cursor.index + 1 },
            },
          };
        }
        if (input.purpose === "ai_refresh") {
          const owner = await readRun(db, input.runId);
          if (owner && aiRefreshRunInput.parse(owner.input).discovery) {
            const activation = await readAiRefreshActivation(db);
            if (
              !activation?.enabled ||
              activation.discoveryRunId !== input.runId
            )
              throw new JobPausedError(
                "Automatic discovery activation is disabled or superseded",
              );
            const page = await (
              await import("~/server/domains/run/service/ai-refresh")
            ).discoverAiRefresh(db);
            const availableAt = new Date(
              Date.now() +
                (page.deferred ? 30_000 : page.complete ? 120_000 : 0),
            );
            return {
              page: {
                done: false,
                availableAt,
                ...(page.deferred
                  ? {
                      waitUntil: availableAt,
                      waitReason: jobWaitReason.enum.provider_capacity,
                    }
                  : {}),
              },
            };
          }
        }
        const pending = await (
          await import("~/server/domains/run/service/ai-work")
        ).advanceAiWorkRun(db, params);
        // Evaluation settlement wakes this Job (`wakeAiEvaluationRequesters`);
        // the interval only recovers a lost wake.
        return {
          page: {
            done: !pending?.length,
            availableAt: new Date(Date.now() + 60_000),
          },
        };
      },
    ),
);

async function assertNotPaused(
  db: import("~/server/db").Database,
  runId: string,
) {
  const owner = await readRun(db, runEntityId.parse(runId));
  if (owner?.status === "paused_auth")
    throw new JobPausedError(
      owner.dispatchError ?? "Mailbox requires authorization",
    );
}
