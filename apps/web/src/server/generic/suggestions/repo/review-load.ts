import {
  suggestionFamily,
  mailDecisionFamily,
} from "@cubby/schemas/suggestion";
import { and, eq, notInArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import { resolveMailDecisionHandle } from "~/server/domains/purchase-import/repo/mail-decision-review";

import type { Review } from "./review";
import type { Prediction } from "./review-plan";

export async function loadReviewPrediction(db: Database, input: Review) {
  let prediction: Prediction | undefined;
  if (input.suggestionId) {
    [prediction] = await getDb(db)
      .select({
        id: suggestionTable.id,
        fingerprint: suggestionTable.fingerprint,
        family: suggestionTable.family,
        subject: suggestionTable.subject,
        judgment: suggestionTable.judgment,
        producer: suggestionTable.producer,
        // Only field application consumes captured correction inputs; history must not load unrelated snapshots.
        evidence: sql`CASE WHEN ${suggestionTable.family} = ${suggestionFamily.enum.field} AND ${input.intent === "apply"} THEN ${suggestionTable.evidence} ELSE NULL END`,
      })
      .from(suggestionTable)
      .where(
        and(
          eq(suggestionTable.id, input.suggestionId),
          notInArray(suggestionTable.family, ["field", "recommendation"]),
        ),
      )
      .limit(1);
    // A mail decision's owner answers for its handle; carried rows kept their id.
    if (
      !prediction ||
      mailDecisionFamily.safeParse(prediction.family).success
    ) {
      const mail = await resolveMailDecisionHandle(db, input.suggestionId);
      if (mail) {
        return { kind: "mail" as const, mail };
      }
      prediction = undefined;
    }
  }
  return { kind: "prediction" as const, prediction };
}
