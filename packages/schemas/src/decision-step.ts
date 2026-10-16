import { z } from "zod";

// Ordered decisions a member makes before one apply. The server derives every
// step; clients render them and never recompute readiness.
export const decisionStepStatus = z.enum([
  "done",
  "needs_input",
  "blocked",
  "not_needed",
]);
export type DecisionStepStatus = z.infer<typeof decisionStepStatus>;

// The outcome a pending decision will have; drives the action colour channel.
export const decisionAction = z.enum(["create", "link", "change", "remove"]);
export type DecisionAction = z.infer<typeof decisionAction>;

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
