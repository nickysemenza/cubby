import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { runAfterCommit } from "~/server/db/helpers";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { makeJobsDueNow } from "~/server/generic/jobs/repo/operator";
import { wakeJobs } from "~/server/workflows/background-tasks/publish";

/**
 * A settled set wakes each owner/requester Run once after commit: the
 * `run.execute` Pass of a live step or AI-work Run becomes due now, and a
 * mail discovery Run's Job does.
 */
export async function wakeAiEvaluationRequesters(
  db: Database,
  evaluationIds: string | readonly string[],
) {
  const ids =
    typeof evaluationIds === "string" ? [evaluationIds] : evaluationIds;
  if (!ids.length) return;
  const requesters = sql`SELECT e."runId" FROM "AiEvaluation" e WHERE e.id = ANY(${uuidArrayParam(ids)}) AND e."runId" IS NOT NULL
      UNION SELECT r."runId" FROM "AiEvaluationRequest" r WHERE r."evaluationId" = ANY(${uuidArrayParam(ids)}) AND r."cancelledAt" IS NULL`;
  await makeJobsDueNow(
    db,
    sql`SELECT 'run:' || requesters."runId"::text FROM (${requesters}) requesters`,
  );
  const { wakeRunPasses } = await import("./run-pass");
  await wakeRunPasses(db, requesters);
  await runAfterCommit(db, () => wakeJobs({ source: "run-receipt" }));
}
