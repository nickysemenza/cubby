import { z } from "zod";

// Ordered decisions a member makes before one apply. The server derives every
// step; clients render them and never recompute readiness.
/** @public Names a generated native model. */
export const decisionStepStatus = z.enum([
  "done",
  "needs_input",
  "blocked",
  "not_needed",
]);

// The outcome a pending decision will have; drives the action colour channel.
/** @public Names a generated native model. */
export const decisionAction = z.enum(["create", "link", "change", "remove"]);

export const decisionStep = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  status: decisionStepStatus,
  summary: z.string().nullable(),
  action: decisionAction.nullable(),
  // Why the step cannot be answered yet; required when status is blocked.
  blockedReason: z.string().nullable(),
});
export type DecisionStep = z.infer<typeof decisionStep>;
