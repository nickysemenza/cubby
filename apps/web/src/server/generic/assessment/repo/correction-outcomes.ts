import {
  CORRECTION_OUTCOME_RECEIPT_KIND,
  suggestionCorrectionOutcome,
} from "@cubby/schemas/suggestion-correction";
import { and, desc, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { feedback } from "~/server/db/schema";

/** Bounded to the page's Assessment ids; immutable receipts are the audit owner. */
export async function readCorrectionOutcomes(
  db: Database,
  assessmentIds: readonly string[],
) {
  const results = new Map<
    string,
    {
      outcome: z.infer<typeof suggestionCorrectionOutcome>;
      correctedValue: z.infer<ReturnType<typeof z.json>>;
    }
  >();
  if (!assessmentIds.length) return results;
  const rows = await getDb(db)
    .selectDistinctOn([feedback.assessmentId], {
      assessmentId: feedback.assessmentId,
      receipt: feedback.receipt,
      metadata: feedback.metadata,
    })
    .from(feedback)
    .where(
      and(
        inArray(feedback.assessmentId, [...assessmentIds]),
        sql`${feedback.metadata}->>${"kind"} = ${CORRECTION_OUTCOME_RECEIPT_KIND}`,
      ),
    )
    .orderBy(
      feedback.assessmentId,
      desc(feedback.createdAt),
      desc(feedback.id),
    );
  for (const row of rows) {
    const metadata = z.object({ correctedValue: z.json() }).parse(row.metadata);
    results.set(row.assessmentId, {
      outcome: suggestionCorrectionOutcome.parse(row.receipt),
      correctedValue: metadata.correctedValue,
    });
  }
  return results;
}
