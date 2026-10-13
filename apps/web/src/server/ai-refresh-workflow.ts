import { aiRefreshRunInput } from "@cubby/schemas/ai-evaluation";
import { runEntityId } from "@cubby/schemas/identifiers";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";

import { setCfEnv } from "./cf-env";
import { withRequestDbClient } from "./db";
import { aiEvaluation, run } from "./db/schema";
import { getDb } from "./repo/database-helpers";
import type { WorkflowRunParams } from "./workflow-runs/contract";
import { claimWorkflowRun, failWorkflowRun } from "./workflow-runs/lifecycle";

export class AiRefreshWorkflow extends WorkflowEntrypoint<
  Env,
  WorkflowRunParams
> {
  async run(
    event: Readonly<WorkflowEvent<WorkflowRunParams>>,
    step: WorkflowStep,
  ) {
    setCfEnv(this.env);
    const { aiEvaluationProgress } = await import("./repo/ai-evaluation");
    const { executeAiRefreshTarget } = await import("./runs/ai-refresh");
    const withDb = async <T>(
      work: (db: typeof import("./db").db) => Promise<T>,
    ) =>
      withRequestDbClient(this.env.HYPERDRIVE.connectionString, async () =>
        work((await import("./db")).db),
      );
    try {
      const discovery = await withDb(async (db) => {
        const owner = await claimWorkflowRun(db, event.payload);
        return owner ? aiRefreshRunInput.parse(owner.input).discovery : false;
      });
      if (discovery) {
        for (let page = 0; ; page++) {
          const more = await step.do(
            `discover:${page}`,
            {
              retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
              timeout: "15 minutes",
            },
            () =>
              withDb(async (db) => {
                const { readAiRefreshActivation, readAiDiscoveryCursor } =
                  await import("./repo/ai-refresh");
                const current = await readAiRefreshActivation(db);
                const owner = await claimWorkflowRun(db, event.payload);
                if (
                  !owner ||
                  !current?.enabled ||
                  current.revision !==
                    aiRefreshRunInput.parse(owner.input).activation.revision
                )
                  return false;
                if (
                  !(await (
                    await import("./runs/ai-refresh")
                  ).recoverAiRefresh(db))
                )
                  throw new Error(
                    "Discovery Workflow policy differs from activated policy",
                  );
                const cursor = await readAiDiscoveryCursor(db);
                return (
                  cursor.revision === current.revision &&
                  !(cursor.fieldDone && cursor.emailDone)
                );
              }),
          );
          if (!more) break;
        }
      }
      for (let cycle = 0; ; cycle++) {
        const pending = await withDb(async (db) => {
          if (!(await claimWorkflowRun(db, event.payload))) return null;
          const rows = await getDb(db)
            .select()
            .from(aiEvaluation)
            .where(eq(aiEvaluation.runId, event.payload.runId));
          await getDb(db)
            .update(run)
            .set({
              progress: aiEvaluationProgress(rows, event.payload.attempt),
            })
            .where(
              and(
                eq(run.id, runEntityId.parse(event.payload.runId)),
                eq(run.status, "running"),
                sql`COALESCE((${run.progress}->>'attempt')::integer, 0) = ${event.payload.attempt}`,
              ),
            );
          return getDb(db)
            .select({
              id: aiEvaluation.id,
              state: aiEvaluation.state,
              deadlineAt: aiEvaluation.deadlineAt,
              nextAttemptAt: aiEvaluation.nextAttemptAt,
            })
            .from(aiEvaluation)
            .where(
              and(
                eq(aiEvaluation.runId, event.payload.runId),
                notInArray(aiEvaluation.state, [
                  "completed",
                  "blocked",
                  "failed",
                  "obsolete",
                  "cancelled",
                ]),
              ),
            )
            .orderBy(
              sql`COALESCE(${aiEvaluation.nextAttemptAt}, ${aiEvaluation.deadlineAt}, ${aiEvaluation.createdAt})`,
            )
            .limit(2);
        });
        if (pending === null) break;
        if (!pending.length) {
          await withDb(async (db) => {
            if (!(await claimWorkflowRun(db, event.payload))) return;
            const rows = await getDb(db)
              .select()
              .from(aiEvaluation)
              .where(eq(aiEvaluation.runId, event.payload.runId));
            const progress = aiEvaluationProgress(rows, event.payload.attempt);
            await getDb(db)
              .update(run)
              .set({
                status: progress.failed ? "failed" : "completed",
                failureCode: progress.failed ? "ai_refresh_failed" : null,
                dispatchError: progress.errors?.join("\n") || null,
                endedAt: new Date(),
                progress,
              })
              .where(
                and(
                  eq(run.id, runEntityId.parse(event.payload.runId)),
                  eq(run.status, "running"),
                  sql`COALESCE((${run.progress}->>'attempt')::integer, 0) = ${event.payload.attempt}`,
                ),
              );
          });
          break;
        }
        const now = Date.now();
        const due = pending.filter(
          (row) =>
            row.state === "queued" ||
            (row.state === "retry_wait" &&
              (row.nextAttemptAt?.getTime() ?? 0) <= now) ||
            (["running", "result_ready"].includes(row.state) &&
              (row.deadlineAt?.getTime() ?? 0) <= now),
        );
        const attempts = await Promise.all(
          due.map(({ id }) =>
            step.do(
              `target:${cycle}:${id}`,
              {
                retries: {
                  limit: 2,
                  delay: "5 seconds",
                  backoff: "exponential",
                },
                timeout: "15 minutes",
              },
              () =>
                withDb(async (db) => {
                  const admitted = (await claimWorkflowRun(db, event.payload))
                    ? await executeAiRefreshTarget(db, id)
                    : false;
                  return { id, admitted };
                }),
            ),
          ),
        );
        await step.sleep(
          `pace:${cycle}`,
          z
            .array(z.object({ admitted: z.boolean() }))
            .parse(attempts)
            .some((attempt) => attempt.admitted)
            ? "1 second"
            : "30 seconds",
        );
      }
    } catch (error) {
      await step.do(
        "fail",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
        () =>
          withDb((db) =>
            failWorkflowRun(db, event.payload, {
              failureCode: "ai_refresh_workflow_failed",
              message: scrubErrorMessage(String(error)),
            }),
          ),
      );
      throw error;
    }
    return { runId: event.payload.runId };
  }
}
