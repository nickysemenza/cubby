import type { RunId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, runAfterCommit } from "~/server/db/helpers";
import { aiEvaluationRequest, job } from "~/server/db/retained-tables";
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
export async function wakeAiEvaluationRequesters(
  db: Database,
  evaluationId: string,
) {
  const owners = await getDb(db)
    .select({ runId: aiEvaluationRequest.runId })
    .from(aiEvaluationRequest)
    .where(
      and(
        eq(aiEvaluationRequest.evaluationId, evaluationId),
        isNull(aiEvaluationRequest.cancelledAt),
      ),
    );
  for (const owner of owners) await wakeRun(db, owner.runId);
}
export async function wakeStepRunParent(db: Database, childRunId: RunId) {
  const parent = await (
    await import("~/server/domains/run/repo/run-step")
  ).stepParentOf(db, childRunId);
  if (parent) await wakeRun(db, parent.runId);
}
