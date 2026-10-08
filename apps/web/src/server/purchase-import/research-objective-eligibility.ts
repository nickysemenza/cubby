import type { ResearchObjectivesRunInput } from "@cubby/schemas/run-fields";

import type { runTarget } from "~/server/db/schema";

import { CHARGE_RESEARCH_UNRESOLVED_STATES } from "./charge-hunt-state";
import { researchObjectiveKey } from "./research-objective";
import type { lockObjectiveHunts } from "./research-objective-source-locks";

/** Receipt disposal and ordinary retry share the same current financial/write ownership fence. */
export function eligibleObjectiveContinuation(
  frozen: ResearchObjectivesRunInput,
  hunts: Awaited<ReturnType<typeof lockObjectiveHunts>>,
  targets: Pick<typeof runTarget.$inferSelect, "workKey" | "state">[],
) {
  const huntIds = frozen.objectives.flatMap((objective) =>
    objective.kind === "charge_hunt" || objective.kind === "receipt_hunt"
      ? [objective.huntId]
      : [],
  );
  if (hunts.length !== new Set(huntIds).size)
    throw new Error(
      "Objective hunt identity or financial-account ownership changed.",
    );
  return frozen.objectives.filter((objective) => {
    const target = targets.find(
      (value) => value.workKey === researchObjectiveKey(objective),
    );
    if (!target) return false;
    if (
      objective.kind === "account_history" ||
      objective.kind === "vendor_purchases"
    )
      return true;
    const found = hunts.find((row) => row.hunt.id === objective.huntId);
    if (!found) throw new Error("Objective hunt identity changed.");
    if (objective.kind === "charge_hunt") {
      if (
        found.transaction.id !== objective.financialTransactionId ||
        found.hunt.vendorAccountId !== objective.vendorAccountId
      )
        throw new Error("Selected charge objective changed identity.");
      if (found.settled || found.held) return false;
      return CHARGE_RESEARCH_UNRESOLVED_STATES.some(
        (state) => state === found.hunt.state,
      );
    }
    if (found.settled || found.held) return false;
    return (
      target.state !== "completed" &&
      ["receipt_failed", "processing_receipt", "deferred_for_review"].includes(
        found.hunt.state,
      )
    );
  });
}
