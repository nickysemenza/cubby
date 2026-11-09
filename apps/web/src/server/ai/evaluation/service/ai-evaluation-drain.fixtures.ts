import { eq, isNotNull, and } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation } from "~/server/db/schema";

/** What the drain still owes for the evaluation, or undefined once it settled or parked. */
export async function aiEvaluationItem(db: Database, id: string) {
  const [row] = await getDb(db)
    .select({
      ref: aiEvaluation.id,
      feature: aiEvaluation.feature,
      priority: aiEvaluation.priority,
      attempts: aiEvaluation.attempts,
      readyAt: aiEvaluation.runAt,
      lastError: aiEvaluation.error,
      waitCause: aiEvaluation.waitCause,
    })
    .from(aiEvaluation)
    .where(and(eq(aiEvaluation.id, id), isNotNull(aiEvaluation.runAt)));
  return row;
}

/** How many evaluations the drain owes. */
export const owedAiEvaluations = async (db: Database) =>
  (
    await getDb(db)
      .select({ id: aiEvaluation.id })
      .from(aiEvaluation)
      .where(isNotNull(aiEvaluation.runAt))
  ).length;
