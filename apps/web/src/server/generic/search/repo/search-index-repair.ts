import { parseEntityId } from "@cubby/schemas/identifiers";
import { inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  getDb,
  runAfterCommit,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { enqueueJob, retryJob } from "~/server/generic/jobs/repo/jobs";
import { wakeJobs } from "~/server/workflows/background-tasks/publish";

export const scheduleSearchRepair = (db: Database) =>
  withTransactionDatabase(db, async (tx) => {
    const ids: string[] = [];
    for (const family of ["search", "orphans", "embeddings"] as const) {
      let execution = await enqueueJob(tx, {
        key: `refresh:${family}`,
        kind: "refresh.family",
        input: { family },
        invalidate: true,
      });
      if (["failed", "paused", "cancelled"].includes(execution.state))
        execution = (await retryJob(tx, execution.id)) ?? execution;
      ids.push(execution.id);
    }
    await runAfterCommit(tx, () =>
      wakeJobs({ source: "search.explicit-repair" }),
    );
    return ids;
  });

export const readSearchRepairJobs = (db: Database, ids: string[]) =>
  getDb(db)
    .select()
    .from(job)
    .where(
      inArray(
        job.id,
        ids.map((id) => parseEntityId("job", id)),
      ),
    );
