/** One purchase-line Decision stage (reversal, kit, ...) for an extracted line. */
import { runEntityId } from "@cubby/schemas/identifiers";
import { type ExtractedPurchaseLine } from "@cubby/schemas/purchase-import";

import { runDecisionChoice } from "~/server/ai/decision-model";
import { PURCHASE_LINE_DECISIONS } from "~/server/ai/policy/features";
import type { Database } from "~/server/db";

export async function chooseLineStage(
  db: Database,
  runId: string,
  index: number,
  line: ExtractedPurchaseLine,
  stage: keyof typeof PURCHASE_LINE_DECISIONS,
) {
  const spec = PURCHASE_LINE_DECISIONS[stage];
  return runDecisionChoice({
    feature: spec,
    ...spec.prompt(line),
    usage: {
      db,
      operation: `purchaseImport.${stage}.${index}`,
      runId: runEntityId.parse(runId),
    },
  });
}
