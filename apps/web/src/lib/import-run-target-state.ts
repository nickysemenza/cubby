import type { ImportRunTargetState } from "@cubby/schemas/purchase-import";

import type { BadgeVariant } from "~/components/ui/badge";

// Every state `ImportRunTarget.state` can hold. `needs_evidence` and
// `unavailable` are purchase-validation-only states a photo or product
// target never reaches, but the roster stays exhaustive so a future state
// addition fails loudly here instead of silently rendering as "unknown".
export const IMPORT_RUN_TARGET_STATE_ORDER: readonly ImportRunTargetState[] = [
  "pending",
  "prepared",
  "completed",
  "skipped",
  "unresolved",
  "needs_evidence",
  "unavailable",
];

export const IMPORT_RUN_TARGET_STATE_LABEL = {
  pending: "Pending",
  prepared: "Prepared",
  completed: "Completed",
  skipped: "Skipped",
  unresolved: "Unresolved",
  needs_evidence: "Needs evidence",
  unavailable: "Unavailable",
} satisfies Record<ImportRunTargetState, string>;

export const IMPORT_RUN_TARGET_STATE_VARIANT = {
  pending: "slate",
  prepared: "default",
  completed: "positive",
  skipped: "slate",
  unresolved: "warning",
  needs_evidence: "warning",
  unavailable: "destructive",
} satisfies Record<ImportRunTargetState, BadgeVariant>;

export const isImportRunTargetState = (
  value: string,
): value is ImportRunTargetState =>
  // SAFETY: widening to `readonly string[]` only relaxes the search value's
  // type for `.includes`; the array's own literal members are unchanged, so
  // membership still means `value` is a genuine `ImportRunTargetState`.
  (IMPORT_RUN_TARGET_STATE_ORDER as readonly string[]).includes(value);
