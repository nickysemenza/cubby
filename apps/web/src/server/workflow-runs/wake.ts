import { and, eq, isNull } from "drizzle-orm";

import { getAiRefreshWorkflow } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { aiEvaluationRequest, run } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { runAfterCommit } from "~/server/repo/database-helpers/core";

import { workflowInstanceId } from "./contract";

/** Durable state owns the result; a lost event is recovered at the due-time wait. */
export async function wakeAiEvaluationRequesters(
  db: Database,
  evaluationId: string,
) {
  const binding = getAiRefreshWorkflow();
  if (!binding) return;
  const owners = await getDb(db)
    .select({ shortcode: run.shortcode, progress: run.progress })
    .from(aiEvaluationRequest)
    .innerJoin(run, eq(run.id, aiEvaluationRequest.runId))
    .where(
      and(
        eq(aiEvaluationRequest.evaluationId, evaluationId),
        isNull(aiEvaluationRequest.cancelledAt),
        eq(run.status, "running"),
      ),
    );
  await runAfterCommit(db, () =>
    Promise.allSettled(
      owners.map(async (owner) => {
        const progress = owner.progress;
        const attempt =
          progress &&
          "attempt" in progress &&
          typeof progress.attempt === "number"
            ? progress.attempt
            : 0;
        if (attempt > 0)
          await (
            await binding.get(workflowInstanceId(owner.shortcode, attempt))
          ).sendEvent({ type: "ai-work", payload: {} });
      }),
    ).then(() => undefined),
  );
}
