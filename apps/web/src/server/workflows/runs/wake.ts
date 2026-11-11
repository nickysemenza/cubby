import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { runAfterCommit } from "~/server/db/helpers";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { makeJobsDueNow } from "~/server/generic/jobs/repo/operator";
import { wakeJobs } from "~/server/workflows/background-tasks/publish";

/** A settled set wakes each owner/requester coordinator once after commit. */
export async function wakeAiEvaluationRequesters(
  db: Database,
  evaluationIds: string | readonly string[],
) {
  const ids =
    typeof evaluationIds === "string" ? [evaluationIds] : evaluationIds;
  if (!ids.length) return;
  await makeJobsDueNow(
    db,
    sql`SELECT 'run:' || e."runId"::text FROM "AiEvaluation" e WHERE e.id = ANY(${uuidArrayParam(ids)})
      UNION SELECT 'run:' || r."runId"::text FROM "AiEvaluationRequest" r WHERE r."evaluationId" = ANY(${uuidArrayParam(ids)}) AND r."cancelledAt" IS NULL`,
  );
  await runAfterCommit(db, () => wakeJobs({ source: "run-receipt" }));
}
