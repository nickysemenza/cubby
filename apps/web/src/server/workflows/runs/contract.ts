// Pure domain checkpoint types shared by the Job runner and its callers.
import { z } from "zod";

export {
  EXECUTED_RUN_PURPOSES,
  isExecutedRunPurpose,
  isStepRunPurpose,
  type ExecutedRunPurpose,
} from "@cubby/schemas/run-fields";

/** Domain checkpoint context. Universal Job token/generation owns writes. */
const workflowRunParams = z.object({
  runId: z.uuid(),
  /** Historical progress label; never an execution capability. */
  attempt: z.number().int().nonnegative(),
});
export type WorkflowRunParams = Readonly<z.infer<typeof workflowRunParams>>;
