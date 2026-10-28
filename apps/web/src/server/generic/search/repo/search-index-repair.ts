import type { Database } from "~/server/db";
import { runAfterCommit, withTransactionDatabase } from "~/server/db/helpers";
import {
  DERIVED_DRAIN_JOB_KEY,
  markAllStoredDerived,
} from "~/server/generic/derived/repo/drain";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { retryJob } from "~/server/generic/jobs/repo/operator";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { wakeJobs } from "~/server/workflows/background-tasks/publish";

/** Mark every search document for rebuild; the derived drain does the work (ADR 0021). */
export const scheduleSearchRepair = (db: Database) =>
  withTransactionDatabase(db, async (tx) => {
    await markAllStoredDerived(tx, (declaration) =>
      declaration.compute.startsWith("search."),
    );
    let execution = await enqueueJob(tx, {
      key: DERIVED_DRAIN_JOB_KEY,
      kind: "derived.drain",
      input: {},
      invalidate: true,
    });
    if (["failed", "paused", "cancelled"].includes(execution.state))
      execution = (await retryJob(tx, execution.id)) ?? execution;
    await runAfterCommit(tx, () =>
      wakeJobs({ source: "search.explicit-repair" }),
    );
    return [execution.id];
  });

export const readSearchRepairJobs = (db: Database, ids: string[]) =>
  readJobs(db, { ids });
