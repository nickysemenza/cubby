import type { KernelStage } from "@cubby/schemas/kernel/stage";
import type { RunTargetState } from "@cubby/schemas/purchase-import";

export const RUN_TARGET_STATE_LABEL = {
  pending: "Pending",
  prepared: "Prepared",
  completed: "Completed",
  skipped: "Skipped",
  unresolved: "Unresolved",
  needs_evidence: "Needs evidence",
  unavailable: "Unavailable",
} satisfies Record<RunTargetState, string>;

/** Each target state as its stage; `StateBadge` draws it. */
export const RUN_TARGET_STATE_STAGE = {
  pending: "waiting",
  prepared: "working",
  completed: "done",
  skipped: "ended",
  unresolved: "needs_you",
  needs_evidence: "waiting",
  unavailable: "stuck",
} satisfies Record<RunTargetState, KernelStage>;
