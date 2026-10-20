import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import { getAiGatewayEgress, setCfEnv } from "../cf-env";
import { withInvocationDb } from "../db";
import type { WorkflowRunParams } from "./runs/contract";
import { runDeploymentBoundary } from "./runs/deployment";
import { assertWorkflowCurrent, withWorkflowExecution } from "./runs/execution";
import { failWorkflowRun } from "./runs/lifecycle";
import { runStepRunWorkflow } from "./step-run-execution";

/**
 * One attempt of a step-ledger Run (maintenance, sweep). Every page and every
 * child wait counts toward one instance's bound; past it the attempt hands off
 * to a fresh instance that resumes from the RunStep cursors.
 */
export class StepRunWorkflow extends WorkflowEntrypoint<
  Env,
  WorkflowRunParams
> {
  async run(
    event: Readonly<WorkflowEvent<WorkflowRunParams>>,
    step: WorkflowStep,
  ) {
    setCfEnv(this.env);
    const { advanceStepRun, inspectStepRun } =
      await import("../domains/run/service/step-run");
    const withDb = async <T>(
      work: (db: typeof import("../db").db) => Promise<T>,
    ) =>
      withInvocationDb(this.env.HYPERDRIVE.connectionString, async () =>
        work((await import("../db")).db),
      );
    await runStepRunWorkflow(
      {
        do: (name, config, callback) => step.do(name, config, callback),
        sleep: (name, duration) => step.sleep(name, duration),
      },
      {
        inspect: () => withDb((db) => inspectStepRun(db, event.payload)),
        boundary: runDeploymentBoundary(this.env, step, event.payload),
        advance: () =>
          withWorkflowExecution(event.payload, () =>
            withDb(async (db) => {
              await assertWorkflowCurrent();
              return advanceStepRun(db, event.payload);
            }),
          ),
        wait: async (page, seconds) => {
          await step.waitForEvent(`child:${page}`, {
            type: "step-run",
            timeout: `${seconds} seconds`,
          });
        },
        // Every retry opens a fresh awaited scope, including its database pool.
        fail: (message) =>
          withDb((db) =>
            failWorkflowRun(db, event.payload, {
              failureCode: "step_run_workflow_failed",
              message,
            }),
          ),
        recover: async () => {
          await getAiGatewayEgress(CUBBY_AI_GATEWAY_ID)?.scheduleAiWorkRecovery(
            event.payload.runId,
          );
        },
      },
    );
    return { runId: event.payload.runId };
  }
}
