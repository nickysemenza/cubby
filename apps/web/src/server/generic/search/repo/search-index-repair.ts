import { or, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { storedDerivedDeclarations } from "~/server/db/derived-declarations";
import { runAfterCommit, withTransactionDatabase } from "~/server/db/helpers";
import {
  DERIVED_DRAIN_JOB_KEY,
  markAllStoredDerived,
} from "~/server/generic/derived/repo/drain";
import { fanoutTargetMatches } from "~/server/generic/derived/repo/fanout";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { retryJob } from "~/server/generic/jobs/repo/operator";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { hasPendingWork } from "~/server/generic/jobs/repo/work-items";
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

export async function readSearchRepairProgress(db: Database, ids: string[]) {
  const targets = storedDerivedDeclarations()
    .filter((declaration) => declaration.compute.startsWith("search."))
    .map(({ target }) => target);
  const pending =
    targets.length > 0 &&
    (await hasPendingWork(db, DERIVED_DRAIN_JOB_KEY, (column) =>
      or(
        ...targets.map(
          (target) =>
            sql`(${column} = ${target} OR ${fanoutTargetMatches(column, sql`${target}::text`)})`,
        ),
      )!,
    ));
  return { executions: await readJobs(db, { ids }), pending: !!pending };
}
