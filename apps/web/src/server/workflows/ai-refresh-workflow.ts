import { aiRefreshRunInput } from "@cubby/schemas/ai-evaluation";
import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { z } from "zod";

import { getAiGatewayEgress, setCfEnv } from "../cf-env";
import { withInvocationDb } from "../db";
import type { WorkflowRunParams } from "./runs/contract";
import { runDeploymentBoundary } from "./runs/deployment";
import {
  claimWorkflowRun,
  failWorkflowRun,
  runFailureText,
} from "./runs/lifecycle";

const DISCOVERY_POLICY_WAITS = 30;

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
      withInvocationDb(this.env.HYPERDRIVE.connectionString, async () =>
        work((await import("../db")).db),
      );
    try {
      const boundary = runDeploymentBoundary(this.env, step, event.payload);
      const discovery = await withDb(async (db) => {
        const owner = await claimWorkflowRun(db, event.payload);
        return owner?.purpose === "ai_refresh"
          ? aiRefreshRunInput.parse(owner.input).discovery
          : false;
      });
      if (discovery) {
        let policyWaits = 0;
        for (let page = 0; page < 128; page++) {
          if (await boundary(`discover:${page}`))
            return { runId: event.payload.runId };
          // true: more pages; false: done; null: this isolate's policy differs from the activation.
          const more = await step.do(
            `discover:${page}`,
            {
              retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
              timeout: "15 minutes",
            },
            (): Promise<boolean | null> =>
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
                  return null;
                const cursor = await readAiDiscoveryCursor(db);
                return (
                  cursor.revision === current.revision &&
                  !(
                    cursor.fieldDone &&
                    cursor.emailDone &&
                    cursor.productDone &&
                    cursor.connectionDone
                  )
                );
              }),
          );
          if (more === false) break;
          if (more === null) {
            // Deploy overlap: the activation row matches this isolate once the
            // Gateway observation commits, or its revision bump ends this discovery.
            if (++policyWaits > DISCOVERY_POLICY_WAITS)
              throw new Error(
                "Discovery Workflow policy differs from activated policy",
              );
            await step.sleep(`await-policy:${page}`, "1 minute");
          }
          if (page === 127) {
            await boundary("continue-discovery", true);
            return { runId: event.payload.runId };
          }
        }
      }
      for (let cycle = 0; cycle < 128; cycle++) {
        if (await boundary(`cycle:${cycle}`))
          return { runId: event.payload.runId };
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
            ? Math.min(60, Math.max(1, Math.ceil((next - Date.now()) / 1_000)))
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
      await boundary("continue", true);
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
