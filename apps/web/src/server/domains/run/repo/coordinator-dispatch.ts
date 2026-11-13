import type { RunId } from "@cubby/schemas/identifiers";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { jobState } from "@cubby/schemas/job";
import {
  purchaseAgentEvent,
  purchaseAgentEventKeys,
  type PurchaseAgentEvent,
} from "@cubby/schemas/purchase-import";
import { runStatus } from "@cubby/schemas/run-fields";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { runAfterCommit, withTransaction } from "~/server/db/helpers/core";
import { notDeleted } from "~/server/db/helpers/predicates";
import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { wakeJobs } from "~/server/workflows/background-tasks/publish";

import { runPurposeLifecycle } from "./purpose-lifecycle";

/** Commit handoff intent with admission. Retries retain one operation identity. */
async function dispatchRunEvent(
  db: RepositoryQueryInput,
  submitted: PurchaseAgentEvent,
) {
  const event = purchaseAgentEvent.parse(submitted);
  const saved = await enqueueJob(db, {
    key: purchaseAgentEventKeys(event).job,
    kind: "purchase.dispatch",
    runId: event.runId,
    input: event,
  });
  await runAfterCommit(db, () => wakeJobs({ source: "purchase.dispatch" }));
  return saved;
}

export async function dispatchStartedRun(
  db: RepositoryQueryInput,
  run: { id: RunId; eventId: string; purpose: string },
): Promise<"running"> {
  await dispatchRunEvent(db, {
    version: 1,
    runId: run.id,
    purpose: agentImportRunPurpose.parse(run.purpose),
    eventId: run.eventId,
    generation: run.eventId,
    type: "start_or_resume",
  });
  return "running";
}

/** Only the current unstarted generation can inherit terminal Job diagnostics. */
const failedUnstartedDispatch = sql`j.kind='purchase.dispatch' AND j.state=${jobState.enum.failed} AND j."runId"=r.id
      AND j.input->>'type'='start_or_resume' AND j.input->>'eventId'=r."dispatchEventId"
      AND r.status=${runStatus.enum.running} AND r."coordinatorStartedAt" IS NULL AND r."retiredAt" IS NULL AND ${notDeleted("r")}`;

/** Returns how many Runs it failed. */
export async function reconcileCoordinatorDispatches(db: Database) {
  return withTransaction(db, async (tx) => {
    const rows = await tx.execute<{
      id: RunId;
      purpose: string;
    }>(
      sql`UPDATE "Run" r SET status=${runStatus.enum.dispatch_failed}, "failureCode"=${runStatus.enum.dispatch_failed},
    "dispatchError"=j.error, "endedAt"=now(), "updatedAt"=now()
    FROM "Job" j WHERE ${failedUnstartedDispatch}
      RETURNING r.id, r.purpose`,
      "objects",
    );
    for (const { id, purpose } of rows)
      await (await runPurposeLifecycle(purpose))?.dispatchFailed?.(tx, id);
    return rows.length;
  });
}
