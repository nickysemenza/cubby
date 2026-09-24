import type { ImportRunTargetState } from "@cubby/schemas/purchase-import";

import type { BadgeVariant } from "~/components/ui/badge";

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
