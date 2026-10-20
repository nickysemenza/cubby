import type { WorkflowRunPurpose } from "../../server/workflows/runs/contract";

/** Deployment, dispatch and dashboard links share the same Workflow declaration. */
export const RUN_WORKFLOWS = {
  MAIL_DISCOVERY: {
    name: "cubby-mail-discovery",
    worker: "cubby",
    exportName: "MailDiscoveryWorkflow",
  },
  AI_REFRESH: {
    name: "cubby-ai-refresh",
    worker: "cubby",
    exportName: "AiRefreshWorkflow",
  },
  STEP_RUN: {
    name: "cubby-step-run",
    worker: "cubby",
    exportName: "StepRunWorkflow",
  },
} as const;

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
