import { sql } from "drizzle-orm";

import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { pruneFinishedJobs } from "~/server/generic/jobs/repo/job-retention";
import { definePass } from "~/server/kernel/api";

const LIMIT = 2_000;

/** Execution rows expire; answers, decisions, evidence, Run history and unfinished work stay. */
export const retentionPass = definePass({
  name: "retention",
  async run(_db, cursor, claim) {
    const removed = await claim.fenced(async (tx) => {
      const jobs = await pruneFinishedJobs(tx, { limit: LIMIT });
      const passes = await repositoryQueries(tx).execute<{ name: string }>(sql`
        WITH doomed AS (
          SELECT name, key FROM "Pass"
          WHERE ("doneAt" IS NOT NULL AND "updatedAt" < now() - interval '8 days')
            OR ("cancelledAt" IS NOT NULL AND "updatedAt" < now() - interval '14 days')
          LIMIT ${LIMIT} FOR UPDATE SKIP LOCKED
        ) DELETE FROM "Pass" p USING doomed d WHERE p.name = d.name AND p.key = d.key
        RETURNING p.name`);
      return jobs === LIMIT || passes.rows.length === LIMIT;
    });
    return {
      cursor,
      done: false,
      availableAt: new Date(Date.now() + (removed ? 0 : 60 * 60_000)),
    };
  },
});
