import type { RunPurpose } from "@cubby/schemas/run-fields";
// Pure domain checkpoint types shared by the Job runner and its callers.
import { z } from "zod";

/** Run purposes admitted to the universal run.execute handler; historical Runs retain their purpose. */
export const WORKFLOW_RUN_PURPOSES = [
  "mail_discovery",
  "ai_refresh",
  "mail_reclassify",
  "suggestion_sweep",
  "maintenance",
  "sweep",
] as const;
export type WorkflowRunPurpose = (typeof WORKFLOW_RUN_PURPOSES)[number];

export {
  isStepRunPurpose,
  type StepRunPurpose,
} from "@cubby/schemas/run-fields";

export const isWorkflowRunPurpose = (
  purpose: RunPurpose | string,
): purpose is WorkflowRunPurpose =>
  WORKFLOW_RUN_PURPOSES.some((candidate) => candidate === purpose);

/** Domain checkpoint context. Universal Job token/generation owns writes. */
const workflowRunParams = z.object({
  runId: z.uuid(),
  /** Historical progress label; never an execution capability. */
  attempt: z.number().int().nonnegative(),
});
export type WorkflowRunParams = Readonly<z.infer<typeof workflowRunParams>>;
