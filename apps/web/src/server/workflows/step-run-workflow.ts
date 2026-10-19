import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import { getAiGatewayEgress, setCfEnv } from "../cf-env";
import { withInvocationDb } from "../db";
import { isStepRunPurpose, type WorkflowRunParams } from "./runs/contract";
import {
  claimWorkflowRun,
  failWorkflowRun,
  launchWorkflowRun,
  runFailureText,
} from "./runs/lifecycle";

/**
 * One attempt of a step-ledger Run (maintenance, sweep). Every page and every
 * child wait counts toward one instance's bound; past it the attempt hands off
 * to a fresh instance that resumes from the RunStep cursors.
 */
const STEP_RUN_PAGES_PER_INSTANCE = 200;

export class StepRunWorkflow extends WorkflowEntrypoint<
  Env,
  WorkflowRunParams
> {
  async run(
    event: Readonly<WorkflowEvent<WorkflowRunParams>>,
    step: WorkflowStep,
  ) {
    setCfEnv(this.env);
    const { advanceStepRun } = await import("../domains/run/service/step-run");
    const withDb = async <T>(
      work: (db: typeof import("../db").db) => Promise<T>,
    ) =>
      withInvocationDb(this.env.HYPERDRIVE.connectionString, async () =>
        work((await import("../db")).db),
      );
    try {
      for (let page = 0; page < STEP_RUN_PAGES_PER_INSTANCE; page++) {
        const advance = await step.do(
          `page:${page}`,
          {
            retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
            timeout: "15 minutes",
          },
          () => withDb((db) => advanceStepRun(db, event.payload)),
        );
        if (advance.kind !== "continue" && advance.kind !== "wait")
          return { runId: event.payload.runId };
        if (advance.kind === "wait")
          try {
            await step.waitForEvent(`child:${page}`, {
              type: "step-run",
              timeout: `${advance.seconds} seconds`,
            });
          } catch {
            // SILENT: the wait is only a hint; its timeout (or any other end)
            // falls through to the next page, which re-reads the child.
          }
      }
      await step.do("continue", () =>
        withDb(async (db) => {
          const owner = await claimWorkflowRun(db, event.payload);
          if (owner && isStepRunPurpose(owner.purpose))
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
              failureCode: "step_run_workflow_failed",
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
