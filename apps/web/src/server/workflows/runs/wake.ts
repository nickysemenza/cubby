import type { RunId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, runAfterCommit } from "~/server/db/helpers";
import {
  aiEvaluation,
  aiEvaluationRequest,
  job,
} from "~/server/db/retained-tables";
import { wakeJobs } from "~/server/workflows/background-tasks/publish";

async function wakeRun(db: Database, runId: RunId) {
  await getDb(db)
    .update(job)
    .set({ availableAt: new Date() })
    .where(
      and(
        eq(job.key, `run:${runId}`),
        inArray(job.state, ["queued", "retry_wait"]),
      ),
    );
  await runAfterCommit(db, () => wakeJobs({ source: "run-receipt" }));
}

/** A settled evaluation wakes every Run waiting on it: its owner and its requesters. */
export async function wakeAiEvaluationRequesters(
  db: Database,
  evaluationId: string,
) {
  const [owner] = await getDb(db)
    .select({ runId: aiEvaluation.runId })
    .from(aiEvaluation)
    .where(eq(aiEvaluation.id, evaluationId));
  const requesters = await getDb(db)
    .select({ runId: aiEvaluationRequest.runId })
    .from(aiEvaluationRequest)
    .where(
      and(
        eq(aiEvaluationRequest.evaluationId, evaluationId),
        isNull(aiEvaluationRequest.cancelledAt),
      ),
    );
  const runIds = new Set([
    ...(owner ? [owner.runId] : []),
    ...requesters.map((row) => row.runId),
  ]);
  for (const runId of runIds) await wakeRun(db, runId);
}
