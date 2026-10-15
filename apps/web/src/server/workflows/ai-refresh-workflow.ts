import { aiRefreshRunInput } from "@cubby/schemas/ai-evaluation";
import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { z } from "zod";

import { getAiGatewayEgress, setCfEnv } from "../cf-env";
import { withRequestDbClient } from "../db";
import { isWorkflowRunPurpose, type WorkflowRunParams } from "./runs/contract";
import {
  claimWorkflowRun,
  failWorkflowRun,
  launchWorkflowRun,
  runFailureText,
} from "./runs/lifecycle";

export class AiRefreshWorkflow extends WorkflowEntrypoint<
  Env,
  WorkflowRunParams
> {
  async run(
    event: Readonly<WorkflowEvent<WorkflowRunParams>>,
    step: WorkflowStep,
  ) {
    setCfEnv(this.env);
    const { advanceAiWorkRun, executeAiWorkTarget } =
      await import("../domains/run/service/ai-work");
    const withDb = async <T>(
      work: (db: typeof import("../db").db) => Promise<T>,
    ) =>
      withRequestDbClient(this.env.HYPERDRIVE.connectionString, async () =>
        work((await import("../db")).db),
      );
    try {
      const discovery = await withDb(async (db) => {
        const owner = await claimWorkflowRun(db, event.payload);
        return owner?.purpose === "ai_refresh"
          ? aiRefreshRunInput.parse(owner.input).discovery
          : false;
      });
      if (discovery) {
        for (let page = 0; page < 128; page++) {
          const more = await step.do(
            `discover:${page}`,
            {
              retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
              timeout: "15 minutes",
            },
            () =>
              withDb(async (db) => {
                const { readAiRefreshActivation, readAiDiscoveryCursor } =
                  await import("../ai/repo/ai-refresh");
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
                    await import("../domains/run/service/ai-refresh")
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
          if (page === 127) {
            await step.do("continue-discovery", () =>
              withDb(async (db) => {
                const owner = await claimWorkflowRun(db, event.payload);
                if (owner && isWorkflowRunPurpose(owner.purpose))
                  await launchWorkflowRun(db, {
                    runId: owner.id,
                    purpose: owner.purpose,
                    expectedAttempt: event.payload.attempt,
                  });
              }),
            );
            return { runId: event.payload.runId };
          }
        }
      }
      for (let cycle = 0; cycle < 128; cycle++) {
        const pending = await withDb((db) =>
          advanceAiWorkRun(db, event.payload),
        );
        if (pending === null || !pending.length) break;
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
                  // Re-entry repairs a failed read/claim; target leases and receipts own effect retries.
                  limit: 2,
                  delay: "5 seconds",
                  backoff: "exponential",
                },
                timeout: "15 minutes",
              },
              () =>
                withDb(async (db) => {
                  const admitted = (await claimWorkflowRun(
                    db,
                    event.payload,
                    "id",
                  ))
                    ? await executeAiWorkTarget(db, id, event.payload.runId)
                    : false;
                  return { id, admitted };
                }),
            ),
          ),
        );
        if (
          z
            .array(z.object({ admitted: z.boolean() }))
            .parse(attempts)
            .some((attempt) => attempt.admitted)
        )
          continue;
        const next = Math.min(
          ...pending.map((row) =>
            (
              row.nextAttemptAt ??
              row.deadlineAt ??
              new Date(now + 30_000)
            ).getTime(),
          ),
        );
        const seconds =
          next > Date.now()
            ? Math.max(1, Math.ceil((next - Date.now()) / 1_000))
            : 30;
        try {
          await step.waitForEvent(`wake:${cycle}`, {
            type: "ai-work",
            timeout: `${seconds} seconds`,
          });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/timeout|timed out/i.test(error.message)
          )
            throw error;
          // SILENT: the expected due-time timeout rechecks durable state; event delivery is only a hint.
        }
      }
      await step.do("continue", () =>
        withDb(async (db) => {
          const owner = await claimWorkflowRun(db, event.payload);
          if (owner && isWorkflowRunPurpose(owner.purpose))
            await launchWorkflowRun(db, {
              runId: owner.id,
              purpose: owner.purpose,
              expectedAttempt: event.payload.attempt,
            });
        }),
      );
    } catch (error) {
      await step.do(
        "fail",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
        () =>
          withDb((db) =>
            failWorkflowRun(db, event.payload, {
              failureCode: "ai_work_workflow_failed",
              message: runFailureText(
                error instanceof Error ? error : String(error),
              ),
            }),
          ),
      );
      await getAiGatewayEgress(CUBBY_AI_GATEWAY_ID)?.scheduleAiWorkRecovery(
        event.payload.runId,
      );
      throw error;
    }
    return { runId: event.payload.runId };
  }
}
