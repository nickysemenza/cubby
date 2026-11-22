import { sql } from "drizzle-orm";

import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { definePass } from "~/server/kernel/api";

const LIMIT = 2_000;

/** Execution rows and old image events expire; answers, decisions, evidence, Run history, attempt receipts and unfinished work stay. */
export const retentionPass = definePass({
  name: "retention",
  async run(_db, cursor, claim) {
    const removed = await claim.fenced(async (tx) => {
      const { repairImageProcessingExecution } =
        await import("~/server/domains/image-processing/repo/image-processing");
      const { pruneImageProcessingEvents } =
        await import("~/server/domains/image-processing/repo/image-processing-history");
      await repairImageProcessingExecution(tx, 500);
      const events = await pruneImageProcessingEvents(tx, LIMIT);
      const passes = await repositoryQueries(tx).execute<{ name: string }>(sql`
        WITH doomed AS (
          SELECT name, key FROM "Pass"
          WHERE ("doneAt" IS NOT NULL AND "updatedAt" < now() - interval '8 days')
            OR ("cancelledAt" IS NOT NULL AND "updatedAt" < now() - interval '14 days')
          LIMIT ${LIMIT} FOR UPDATE SKIP LOCKED
        ) DELETE FROM "Pass" p USING doomed d WHERE p.name = d.name AND p.key = d.key
        RETURNING p.name`);
      return events || passes.rows.length === LIMIT;
    });
    return {
      cursor,
      done: false,
      availableAt: new Date(Date.now() + (removed ? 0 : 60 * 60_000)),
    };
  },
});
