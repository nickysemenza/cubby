import { z } from "zod";

/** Bound infrastructure retries separately from workload effect retries and successful handoffs. */
export const MAX_AUTOMATIC_WORKFLOW_FAILURES = 3;
export const workflowRecoveryProgress = z.object({
  automaticRecoveryFailures: z.number().int().nonnegative().optional(),
});
