// Pure domain checkpoint types shared by the Pass runner and its callers.
import { z } from "zod";

/** Domain checkpoint context. Universal Pass token/generation owns writes. */
const workflowRunParams = z.object({
  runId: z.uuid(),
  /** Historical progress label; never an execution capability. */
  attempt: z.number().int().nonnegative(),
});
export type WorkflowRunParams = Readonly<z.infer<typeof workflowRunParams>>;
