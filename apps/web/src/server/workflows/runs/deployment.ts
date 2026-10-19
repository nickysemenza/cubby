import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";

import { workflowDeploymentBoundary } from "../deployment-boundary";
import type { WorkflowRunParams } from "./contract";
import type { DurableSteps } from "./step";

/** The DO follows deploys; the Workflow's own version binding remains pinned. */
export function runDeploymentBoundary(
  env: Env,
  steps: Pick<DurableSteps, "do">,
  params: WorkflowRunParams,
) {
  const current = () => env.AI_GATEWAY_EGRESS.getByName(CUBBY_AI_GATEWAY_ID);
  return (name: string, force = false) =>
    workflowDeploymentBoundary(steps, {
      name,
      version: env.CF_VERSION_METADATA.id,
      currentVersion: () => current().currentDeploymentVersion(),
      continue: () => current().continueWorkflowRun(params),
      force,
    });
}
