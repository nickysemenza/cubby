import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { runAfterCommit } from "~/server/db/helpers";
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
    sql`SELECT 'run:' || e."runId"::text FROM "AiEvaluation" e WHERE e.id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
      UNION SELECT 'run:' || r."runId"::text FROM "AiEvaluationRequest" r WHERE r."evaluationId" IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}) AND r."cancelledAt" IS NULL`,
  );
  await runAfterCommit(db, () => wakeJobs({ source: "run-receipt" }));
}
