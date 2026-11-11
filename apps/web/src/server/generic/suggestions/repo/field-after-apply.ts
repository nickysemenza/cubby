import { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import { fieldInputFingerprint } from "~/server/generic/suggestions/repo/field-input-fence";
import type { Review } from "~/server/generic/suggestions/repo/review";
import type { Prediction } from "~/server/generic/suggestions/repo/review-plan";
import {
  suggestionRecordId,
  suggestionStateColumns,
} from "~/server/generic/suggestions/repo/suggestion-state";

export async function fieldAfterApply(
  db: Database,
  prediction: Prediction,
  input: Review,
  authority: "automatic" | "member",
) {
  if (authority !== "member" || !input.correction.present) return null;
  const [field] = await getDb(db)
    .select(suggestionStateColumns)
    .from(suggestionTable)
    .where(eq(suggestionTable.id, prediction.id))
    .limit(1);
  if (!field)
    throw new Error("Corrected field application has no saved lineage");
  return {
    ...suggestionAcceptanceReceipt.parse(field.acceptanceReceipt),
    appliedInputFingerprint: await fieldInputFingerprint(
      db,
      field.entity,
      suggestionRecordId(field),
      field.field,
    ),
  };
}
