// Types and pure helpers only: worker-bindings.ts reaches this module, and
// worker-configuration.d.ts types the Workflow bindings from there.
import type { RunPurpose } from "@cubby/schemas/run-fields";

/**
 * Runs a Cloudflare Workflow executes. The Run row is the durable record; a
 * Workflow instance is one attempt at it, named `<runShortcode>-<attempt>`,
 * so a retry starts a fresh instance that resumes from `Run.progress` and
 * never depends on Cloudflare still retaining an older instance's state.
 */
export const WORKFLOW_RUN_PURPOSES = ["mail_search", "mail_discovery"] as const;
export type WorkflowRunPurpose = (typeof WORKFLOW_RUN_PURPOSES)[number];

export const isWorkflowRunPurpose = (
  purpose: RunPurpose | string,
): purpose is WorkflowRunPurpose =>
  WORKFLOW_RUN_PURPOSES.some((candidate) => candidate === purpose);

/** The payload every Workflow-backed Run's instance starts with. */
export interface WorkflowRunParams {
  readonly runId: string;
  /** Steps act only while `Run.progress.attempt` still equals this. */
  readonly attempt: number;
}

export const workflowInstanceId = (runShortcode: string, attempt: number) =>
  `${runShortcode}-${attempt}`;
