import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";

import type { StepPageSummary } from "~/server/domains/run/service/step-run";

import { enqueueBackgroundTask } from "../background-tasks/publish";
import { workflowDeploymentBoundary } from "../deployment-boundary";
import type { WorkflowRunParams } from "./contract";
import type { DurableSteps } from "./step";

/** The DO follows deploys eventually; Workflow metadata remains pinned. */
export function runDeploymentBoundary(
  env: Env,
  steps: DurableSteps,
  params: WorkflowRunParams,
) {
  const current = () => env.AI_GATEWAY_EGRESS.getByName(CUBBY_AI_GATEWAY_ID);
  let initial = true;
  return (
    name: string,
    force = false,
    dashboard?: { nextInstanceId: string; summary: StepPageSummary | null },
  ) => {
    const first = initial;
    initial = false;
    return workflowDeploymentBoundary(steps, {
      name,
      dashboard,
      version: env.CF_VERSION_METADATA.id,
      currentVersion: () => current().currentDeploymentVersion(),
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
      initial: first,
    });
  };
}
