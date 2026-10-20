import { withInvocationDb } from "~/server/db";
import type { StepPageSummary } from "~/server/domains/run/service/step-run";

import { enqueueBackgroundTask } from "../background-tasks/publish";
import { workflowDeploymentBoundary } from "../deployment-boundary";
import { readWorkflowDeployment } from "./activation";
import type { WorkflowRunParams } from "./contract";
import type { DurableSteps } from "./step";

/** Activation is written after verified deployment; DO code is not release authority. */
export function runDeploymentBoundary(
  env: Env,
  steps: DurableSteps,
  params: WorkflowRunParams,
  currentVersion: () => Promise<{ version: string; epoch?: number }> = () =>
    withInvocationDb(env.HYPERDRIVE.connectionString, async () => {
      const activation = await readWorkflowDeployment(
        (await import("~/server/db")).db,
      );
      if (!activation)
        throw new Error("Workflow deployment has not been activated");
      return { version: activation.workerVersion, epoch: activation.epoch };
    }),
) {
  return (
    name: string,
    force = false,
    dashboard?: { nextInstanceId: string; summary: StepPageSummary | null },
  ) => {
    return workflowDeploymentBoundary(steps, {
      name,
      dashboard,
      version: env.CF_VERSION_METADATA.id,
      epoch: params.activationEpoch,
      currentVersion,
      continue: async () => {
        await enqueueBackgroundTask(
          {
            kind: "workflow.continue",
            ...params,
            requestedAt: new Date().toISOString(),
          },
          { source: "workflow.continue", queue: env.BACKGROUND_QUEUE },
        );
      },
      force,
    });
  };
}
