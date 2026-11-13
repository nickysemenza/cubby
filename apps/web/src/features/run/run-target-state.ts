import { runTargetStateOptions } from "@cubby/schemas/compiler/activity-fields";
import type { KernelStage } from "@cubby/schemas/kernel/stage";
import type { RunTargetState } from "@cubby/schemas/purchase-import";

// SAFETY: the schema roster declares every RunTargetState exactly once.
export const RUN_TARGET_STATE_LABEL = Object.fromEntries(
  runTargetStateOptions.map((option) => [option.value, option.label]),
) as Record<RunTargetState, string>;
// SAFETY: the schema roster declares every RunTargetState exactly once.
export const RUN_TARGET_STATE_STAGE = Object.fromEntries(
  runTargetStateOptions.map((option) => [option.value, option.stage]),
) as Record<RunTargetState, KernelStage>;
