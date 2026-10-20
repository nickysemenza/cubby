import type { WorkflowRunPurpose } from "../../server/workflows/runs/contract.ts";
import workflowDefinitions from "./run-workflows.json" with { type: "json" };

/** Worker and deployment config consume the same workflow declarations. */
export const RUN_WORKFLOWS = workflowDefinitions;

const bindingByPurpose = {
  mail_discovery: "MAIL_DISCOVERY",
  ai_refresh: "AI_REFRESH",
  mail_reclassify: "AI_REFRESH",
  suggestion_sweep: "AI_REFRESH",
  maintenance: "STEP_RUN",
  derived_refresh: "STEP_RUN",
  sweep: "STEP_RUN",
} as const satisfies Record<WorkflowRunPurpose, keyof typeof RUN_WORKFLOWS>;

export function workflowForPurpose(purpose: WorkflowRunPurpose) {
  const binding = bindingByPurpose[purpose];
  return { binding, ...RUN_WORKFLOWS[binding] };
}
