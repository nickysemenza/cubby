import { aiRefreshRunInput } from "@cubby/schemas/ai-evaluation";
import { runEntityId } from "@cubby/schemas/identifiers";
import { jobWaitReason } from "@cubby/schemas/job";
import { RUN_KINDS } from "@cubby/schemas/run-fields";
import { createLogger } from "@cubby/worker-tracing";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  claimAiEvaluationPage,
  failAiEvaluationPage,
} from "~/server/ai/repo/ai-evaluation";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/retained-tables";
import { readRun } from "~/server/domains/run/repo/ai-work-state";
import { JobPausedError, JobDeferredError } from "~/server/generic/jobs/errors";
import { JOB_HEARTBEAT_MS } from "~/server/generic/jobs/limits";
import { renewJobPage } from "~/server/generic/jobs/repo/jobs";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";
import type { PreparedJobPage } from "~/server/generic/jobs/types";
import { EXECUTED_RUN_PURPOSES } from "~/server/workflows/runs/contract";
import { withWorkflowExecution } from "~/server/workflows/runs/execution";

const runJobInput = z.object({
  runId: runEntityId,
  purpose: z.enum(EXECUTED_RUN_PURPOSES),
});
import { aiEvaluationJobInput } from "~/server/generic/jobs/inputs";
const mailCursor = z.object({
  phase: z.enum(["list", "save"]),
  index: z.number().int().nonnegative(),
  more: z.boolean().optional(),
});

/**
 * One handler executes every kind its manifest entry gives an `execution`:
 * a RunStep ledger, AI evaluations, or mailbox discovery. RunStep cursors
 * and receipts remain domain checkpoints; only Job owns admission and retries.
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
        return {
          page: {
            done: !pending?.length,
            availableAt: new Date(Date.now() + 5_000),
          },
        };
      },
    ),
);

const singleAiEvaluationJobHandler = defineJobHandler(
  aiEvaluationJobInput,
  async (db, claim, { evaluationId }) => {
    if (claim.key !== `ai-evaluation:${evaluationId}`)
      throw new Error(
        "AI evaluation Job input does not match its execution key",
      );
    const item = await (
      await import("~/server/domains/run/repo/ai-work-state")
    ).readAiEvaluation(db, evaluationId);
    if (!item) throw new Error(`Missing AI evaluation ${evaluationId}`);
    const owner = await readRun(db, item.runId);
    if (
      owner?.status === "paused_auth" &&
      owner.failureCode === "execution_limit"
    )
      await getDb(db)
        .update(run)
        .set({ status: "running" })
        .where(eq(run.id, item.runId));
    await withWorkflowExecution(
      { runId: item.runId, attempt: claim.generation, database: db },
      async () =>
        (
          await import("~/server/domains/run/service/ai-work")
        ).executeAiWorkTarget(db, evaluationId, item.runId),
    );
    const settled = await (
      await import("~/server/domains/run/repo/ai-work-state")
    ).readAiEvaluation(db, evaluationId);
    if (
      settled &&
      ["retry_wait", "queued", "result_ready"].includes(settled.state)
    )
      throw new JobDeferredError(
        settled.error ?? "AI evidence resume",
        new Date(Date.now() + 1_000),
        "provider_capacity",
      );
    if (settled?.state === "failed")
      throw new Error(settled.error ?? "AI evaluation failed");
    if (settled?.state === "running")
      throw new Error("AI evaluation returned without a durable outcome");
    return { page: { done: true } };
  },
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

/** Product and connection evaluations run in pages; other features keep the single-Job handler. */
export const aiEvaluationJobHandler = {
  ...singleAiEvaluationJobHandler,
  async advancePage(
    db: import("~/server/db").Database,
    anchorId: string,
  ): Promise<string> {
    const { job, aiEvaluation } = await import("~/server/db/retained-tables");
    const { parseEntityId } = await import("@cubby/schemas/identifiers");
    const { sql } = await import("drizzle-orm");
    const [anchor] = await getDb(db)
      .select({ item: aiEvaluation, input: job.input })
      .from(job)
      .innerJoin(
        aiEvaluation,
        sql`${job.key}='ai-evaluation:' || ${aiEvaluation.id}::text`,
      )
      .where(eq(job.id, parseEntityId("job", anchorId)));
    if (!anchor)
      return advanceJob(db, anchorId, {
        "ai.evaluation": singleAiEvaluationJobHandler,
      });
    const input = aiEvaluationJobInput.safeParse(anchor.input);
    if (!input.success || input.data.evaluationId !== anchor.item.id)
      return advanceJob(db, anchorId, {
        "ai.evaluation": singleAiEvaluationJobHandler,
      });
    if (
      anchor.item.executionKind !== "ai_refresh" ||
      !["product", "product_pair", "connection"].includes(
        anchor.item.target.kind,
      ) ||
      !(await readAiRefreshActivation(db))?.enabled
    )
      return advanceJob(db, anchorId, {
        "ai.evaluation": singleAiEvaluationJobHandler,
      });
    const targets = await claimAiEvaluationPage(db, anchorId);
    if (!targets.length) return "skipped";
    const log = createLogger("ai-evaluation-page");
    let renewing: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (!renewing)
        renewing = renewJobPage(
          db,
          targets.map((entry) => entry.claim),
        )
          .then((renewed) => {
            log.info("page leases renewed", {
              renewed: renewed.length,
              lost: targets.length - renewed.length,
            });
          })
          .catch((error: unknown) => {
            log.error("page lease renewal failed", { error });
          })
          .finally(() => {
            renewing = undefined;
          });
    }, JOB_HEARTBEAT_MS);
    try {
      const { executeConnectionAiRefreshPage, executeProductAiRefreshPage } =
        await import("~/server/domains/run/service/ai-refresh");
      await (anchor.item.target.kind === "connection"
        ? executeConnectionAiRefreshPage(db, targets)
        : executeProductAiRefreshPage(db, targets));
      return "succeeded";
    } catch (error) {
      await failAiEvaluationPage(
        db,
        targets.map((target) => ({
          target,
          state:
            target.claim.attempts >= target.claim.maxAttempts
              ? "failed"
              : "retry_wait",
          error: error instanceof Error ? error.message : String(error),
        })),
      );
      return "failed";
    } finally {
      clearInterval(heartbeat);
      await renewing;
    }
  },
};
